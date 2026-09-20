import { hashClaimToken, generateClaimToken, generatePublicId } from '../src/lib/tokens.js';

/** 有効なentitlement（=購入済み・未消費）を1件作り、平文claim_tokenを返す */
export async function seedActiveEntitlement(db, { allowed = 1, planCode = 'single' } = {}) {
  const plainToken = generateClaimToken();
  const tokenHash = await hashClaimToken(plainToken);
  const paymentPublicId = generatePublicId('pay');
  const entitlementPublicId = generatePublicId('ent');

  const payRes = await db
    .prepare(
      `INSERT INTO payments (payment_public_id, plan_code, amount, currency, payment_status, paid_at, stripe_event_id)
       VALUES (?, ?, 300, 'jpy', 'paid', datetime('now'), ?)`
    )
    .bind(paymentPublicId, planCode, `evt_${crypto.randomUUID()}`)
    .run();
  const paymentId = payRes.meta.last_row_id;

  const entRes = await db
    .prepare(
      `INSERT INTO purchase_entitlements
         (entitlement_public_id, payment_id, allowed_predictions, status, claim_token_hash)
       VALUES (?, ?, ?, 'active', ?)`
    )
    .bind(entitlementPublicId, paymentId, allowed, tokenHash)
    .run();
  const entitlementId = entRes.meta.last_row_id;

  return { plainToken, tokenHash, paymentId, paymentPublicId, entitlementId, entitlementPublicId };
}

/**
 * 「既に他の誰かが確定済みの予測」を直接DBへ差し込む（申込フローを経由しない）。
 * previous_hash / combination_key の衝突を決定論的に再現するために使う。
 */
export async function seedForeignPrediction(
  db,
  { combinationKey, previousHash, recordHash, displaySequence, numbers }
) {
  const own = await seedActiveEntitlement(db, { allowed: 1 });
  await db
    .prepare(
      `UPDATE purchase_entitlements SET status='consumed', consumed_predictions=1, consumed_at=datetime('now') WHERE id=?`
    )
    .bind(own.entitlementId)
    .run();

  await db
    .prepare(
      `INSERT INTO predictions
         (prediction_id, display_sequence, draw_number,
          number_1, number_2, number_3, number_4, number_5, number_6,
          combination_key, generated_at, payment_id, entitlement_id,
          prediction_index, plan_code, algorithm_version, previous_hash, record_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      crypto.randomUUID(),
      displaySequence,
      'PERMANENT_TRACKING',
      numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5],
      combinationKey,
      new Date().toISOString(),
      own.paymentId,
      own.entitlementId,
      0,
      'single',
      'prototype-v1',
      previousHash,
      recordHash
    )
    .run();
}
