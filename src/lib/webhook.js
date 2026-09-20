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
export async function handleCheckoutSessionCompleted(db, event) {
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

  let payment = await findPaymentByEventOrSession(db, {
    stripeEventId: event.id,
    stripeCheckoutSessionId: session.id,
  });

  if (!payment) {
    const paymentPublicId = generatePublicId('pay');
    const now = new Date().toISOString();
    try {
      const insertRes = await db
        .prepare(
          `INSERT INTO payments
             (payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
              plan_code, amount, currency, payment_status, paid_at, stripe_event_id)
           VALUES (?,?,?,?,?,'jpy','paid',?,?)`
        )
        .bind(
          paymentPublicId,
          session.id,
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
          intent.plan_code,
          300,
          now,
          event.id
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
             VALUES (?,?,?,1,'active',?)`
          )
          .bind(entitlementPublicId, payment.id, intent.id, intent.claim_token_hash),
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
