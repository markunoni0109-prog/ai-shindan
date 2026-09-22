import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken } from '../src/lib/tokens.js';
import {
  signStripePayload,
  buildCheckoutSessionCompletedEvent,
  TEST_STRIPE_WEBHOOK_SECRET,
} from './stripeMock.js';

/**
 * pack50（15,000円・50予測）専用の直接検証。
 * bulk_purchase.test.jsの全プラン共通ループでも価格/件数/重複なし/
 * Permanent Tracking(features)対象はカバー済みだが、ユーザー指示により
 * pack50単体で「50件生成・50件保存・prediction_id/record_hash重複なし・
 * Webhook冪等性・Permanent Tracking初期化」を明示的に直接検証する。
 */

function req(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function sendSignedWebhook(env, eventPayload) {
  const rawBody = JSON.stringify(eventPayload);
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET);
  return worker.fetch(
    new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body: rawBody,
    }),
    env
  );
}

async function createPack50Session(env) {
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'pack50' }), env);
  assert.equal(createRes.status, 200);
  const createBody = await createRes.json();
  assert.equal(createBody.amount, 15000);
  assert.equal(createBody.allowed_predictions, 50);
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  return { createBody, sessionId: intentRow.stripe_checkout_session_id };
}

test('pack50: 50件生成・50件D1保存・prediction_id/record_hash重複なし', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody, sessionId } = await createPack50Session(env);

  const event = buildCheckoutSessionCompletedEvent({
    eventId: 'evt_pack50_direct',
    sessionId,
    amountTotal: 15000,
    paymentIntentId: `pi_${sessionId}`,
  });
  const webhookRes = await sendSignedWebhook(env, event);
  assert.equal(webhookRes.status, 200);
  assert.equal((await webhookRes.json()).received, true);

  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  assert.equal(claimRes.status, 200);
  const claimBody = await claimRes.json();
  assert.equal(claimBody.outcome, 'created');
  assert.equal(claimBody.predictions.length, 50, 'レスポンスで50件生成される');

  const dbCount = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(dbCount.c, 50, 'D1へ50件保存される');

  const ids = claimBody.predictions.map((p) => p.prediction_id);
  assert.equal(new Set(ids).size, 50, 'prediction_idは50件とも一意');
  const hashes = claimBody.predictions.map((p) => p.record_hash);
  assert.equal(new Set(hashes).size, 50, 'record_hashは50件とも一意');

  // hash chainがpayment内で連続していること（previous_hashが直前のrecord_hashと一致）
  const rows = await db
    .prepare('SELECT prediction_index, previous_hash, record_hash FROM predictions WHERE entitlement_id = (SELECT id FROM purchase_entitlements ORDER BY id DESC LIMIT 1) ORDER BY prediction_index ASC')
    .all();
  for (let i = 1; i < rows.results.length; i++) {
    assert.equal(rows.results[i].previous_hash, rows.results[i - 1].record_hash, `index${i}のprevious_hashが直前のrecord_hashと一致`);
  }
});

test('pack50: Permanent Tracking初期化（prediction_generation_features・prediction_tracking_summaryが50件とも登録される）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody, sessionId } = await createPack50Session(env);
  const event = buildCheckoutSessionCompletedEvent({
    eventId: 'evt_pack50_tracking',
    sessionId,
    amountTotal: 15000,
    paymentIntentId: `pi_${sessionId}`,
  });
  await sendSignedWebhook(env, event);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  const featCount = await db.prepare('SELECT COUNT(*) AS c FROM prediction_generation_features').first();
  assert.equal(featCount.c, 50, '特徴量捕捉が50件とも登録される');

  const summaryCount = await db.prepare('SELECT COUNT(*) AS c FROM prediction_tracking_summary').first();
  assert.equal(summaryCount.c, 50, 'Permanent Trackingのsummary行が50件とも初期化される（追跡対象登録）');

  const anyMissing = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM predictions p
       LEFT JOIN prediction_tracking_summary s ON s.prediction_id = p.prediction_id
       WHERE s.prediction_id IS NULL`
    )
    .first();
  assert.equal(anyMissing.c, 0, '未追跡の予測が1件も残っていない');
});

test('pack50: Webhook冪等性（同一event_id・同一session_idの再送でも予測が二重生成されない）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody, sessionId } = await createPack50Session(env);
  const event = buildCheckoutSessionCompletedEvent({
    eventId: 'evt_pack50_dup',
    sessionId,
    amountTotal: 15000,
    paymentIntentId: `pi_${sessionId}`,
  });

  const res1 = await sendSignedWebhook(env, event);
  const res2 = await sendSignedWebhook(env, event);
  const res3 = await sendSignedWebhook(env, event); // 3回送っても同じ
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res3.status, 200);

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 1, 'Webhook再送してもpaymentは1件のまま');
  assert.equal(entCount.c, 1, 'Webhook再送してもentitlementは1件のまま');

  // claimも複数回叩いて、predictionsが50件のまま増えないことを確認
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  const predCount = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(predCount.c, 50, 'Webhook再送・claim再送を重ねても50件のまま（二重生成なし）');
});
