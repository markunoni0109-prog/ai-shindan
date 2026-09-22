/**
 * webhook.js
 * ------------------------------------------------------------------
 * Stripe Webhook（署名検証済み）から呼ばれる本番処理。
 *
 * 冪等性の設計：
 *   - payments.stripe_event_id / stripe_checkout_session_id はUNIQUE。
 *   - purchase_entitlements.payment_id はUNIQUE（1決済＝1entitlement）。
 *   - 処理前に「すでに存在するか」を確認し、存在すれば何もせず終える。
 *   - 確認後の書き込みでも他リクエストと競合しうるため、UNIQUE制約
 *     違反を「すでに処理済み」の合図として捕捉し、正常応答にする。
 *   - payment作成とentitlement作成の間でWorkerが落ちても、再送された
 *     同じWebhookが「payment既存→entitlementだけ作る」経路で自然に
 *     復旧できる設計にしてある（両方を1つのbatchに強制結合しない）。
 * ------------------------------------------------------------------
 */
import { generatePublicId } from './tokens.js';
import { PLAN_CATALOG, isValidPlanCode } from './plans.js';
import { hashEmail } from './email.js';

export class WebhookIgnored extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function findPaymentByEventOrSession(db, { stripeEventId, stripeCheckoutSessionId }) {
  return db
    .prepare(
      `SELECT * FROM payments WHERE stripe_event_id = ? OR stripe_checkout_session_id = ?`
    )
    .bind(stripeEventId, stripeCheckoutSessionId)
    .first();
}

async function findEntitlementByPaymentId(db, paymentId) {
  return db.prepare(`SELECT * FROM purchase_entitlements WHERE payment_id = ?`).bind(paymentId).first();
}

/**
 * checkout.session.completed イベント1件を処理する。
 * 何回呼ばれても最終結果は「payment 1件・entitlement 1件」になる。
 */
export async function handleCheckoutSessionCompleted(db, event, env = {}) {
  const session = event.data?.object;
  if (!session) throw new WebhookIgnored('no_session_object');

  // 今回は同期決済（カード）のみ対応。非同期決済はpayment_statusが
  // 'unpaid'のままcheckout.session.completedが先に飛んでくることが
  // あるため、paid以外は購入権を発行しない。
  if (session.payment_status !== 'paid') {
    throw new WebhookIgnored('not_paid_yet');
  }

  const intent = await db
    .prepare(`SELECT * FROM purchase_intents WHERE stripe_checkout_session_id = ?`)
    .bind(session.id)
    .first();
  if (!intent) throw new WebhookIgnored('purchase_intent_not_found');

  if (intent.status === 'fulfilled') {
    return { outcome: 'already_fulfilled' };
  }

  // 【決済金額の検証】plan_codeはCheckout Session作成時にサーバー自身が
  // 決めた値だが、Stripe側の実際の決済結果（session.amount_total）が
  // その期待金額と一致することを、購入権を発行する前に必ず確認する。
  // 一致しなければ購入権もpaymentも作らずfail-closeする（Stripe側の再送で
  // 再検証されるだけで、二重に予測が発行されることはない）。
  if (!isValidPlanCode(intent.plan_code)) {
    throw new WebhookIgnored('unknown_plan_code');
  }
  const plan = PLAN_CATALOG[intent.plan_code];
  const expectedAmount = plan.amount;
  const paidAmount = Number(session.amount_total);
  const paidCurrency = (session.currency || 'jpy').toLowerCase();
  if (!Number.isFinite(paidAmount) || paidAmount !== expectedAmount || paidCurrency !== 'jpy') {
    console.error(
      'stripe webhook amount mismatch (fail-close, no entitlement issued):',
      JSON.stringify({ sessionId: session.id, planCode: intent.plan_code, expectedAmount, paidAmount, paidCurrency })
    );
    throw new WebhookIgnored('amount_mismatch');
  }

  let payment = await findPaymentByEventOrSession(db, {
    stripeEventId: event.id,
    stripeCheckoutSessionId: session.id,
  });

  if (!payment) {
    const paymentPublicId = generatePublicId('pay');
    const now = new Date().toISOString();

    // 【購入履歴の端末変更復旧用】Stripe Checkoutが収集したメールアドレスを
    // ハッシュ化して記録する（生のメールは保存しない）。EMAIL_HASH_SECRET
    // 未設定・メール未取得等どんな理由でも、ここで例外を投げて決済の
    // 正常処理(payment/entitlement発行)を止めてはならない＝あくまで
    // 付随的な機能として握りつぶし、customer_email_hashはNULLのままにする。
    let customerEmailHash = null;
    const customerEmail = session.customer_details?.email;
    if (customerEmail) {
      try {
        customerEmailHash = await hashEmail(env, customerEmail);
      } catch (err) {
        console.error('customer email hashing failed (non-fatal, recovery feature only):', err.message);
      }
    }

    try {
      const insertRes = await db
        .prepare(
          `INSERT INTO payments
             (payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
              plan_code, amount, currency, payment_status, paid_at, stripe_event_id, access_token_hash, customer_email_hash)
           VALUES (?,?,?,?,?,'jpy','paid',?,?,?,?)`
        )
        .bind(
          paymentPublicId,
          session.id,
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
          intent.plan_code,
          expectedAmount,
          now,
          event.id,
          intent.access_token_hash ?? null,
          customerEmailHash
        )
        .run();
      payment = { id: insertRes.meta.last_row_id, payment_public_id: paymentPublicId };
    } catch (err) {
      // UNIQUE違反＝他リクエスト（webhook再送等）が同時に同じpaymentを作った。
      // 冪等に扱うため、既存行を読み直して続行する。
      payment = await findPaymentByEventOrSession(db, {
        stripeEventId: event.id,
        stripeCheckoutSessionId: session.id,
      });
      if (!payment) throw err;
    }
  }

  let entitlement = await findEntitlementByPaymentId(db, payment.id);
  if (!entitlement) {
    const entitlementPublicId = generatePublicId('ent');
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO purchase_entitlements
               (entitlement_public_id, payment_id, purchase_intent_id, allowed_predictions,
                status, claim_token_hash)
             VALUES (?,?,?,?,'active',?)`
          )
          .bind(entitlementPublicId, payment.id, intent.id, plan.allowed_predictions, intent.claim_token_hash),
        db
          .prepare(`UPDATE purchase_intents SET status='fulfilled', payment_id=?, fulfilled_at=? WHERE id=?`)
          .bind(payment.id, new Date().toISOString(), intent.id),
      ]);
    } catch (err) {
      entitlement = await findEntitlementByPaymentId(db, payment.id);
      if (!entitlement) throw err;
      return { outcome: 'already_fulfilled' };
    }
    return { outcome: 'fulfilled', paymentId: payment.id };
  }

  return { outcome: 'already_fulfilled' };
}
