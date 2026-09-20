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

function req(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createIntentAndGetSessionId(env) {
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const { claim_token } = await createRes.json();
  const tokenHash = await hashClaimToken(claim_token);
  const row = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  return { claimToken: claim_token, sessionId: row.stripe_checkout_session_id };
}

async function postWebhookRaw(env, rawBody, sigHeader) {
  return worker.fetch(
    new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sigHeader ? { 'stripe-signature': sigHeader } : {}) },
      body: rawBody,
    }),
    env
  );
}

test('署名不正なWebhookは400で拒否される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_bad_sig', sessionId });
  const rawBody = JSON.stringify(event);

  const res = await postWebhookRaw(env, rawBody, 't=1234567890,v1=deadbeef');
  assert.equal(res.status, 400);

  // 拒否されたのでpayment/entitlementは作られていない
  const count = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  assert.equal(count.c, 0);
});

test('署名ヘッダーが無いWebhookも400で拒否される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await postWebhookRaw(env, JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed' }), null);
  assert.equal(res.status, 400);
});

test('タイムスタンプが古すぎる署名はリプレイとして拒否される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_old', sessionId });
  const rawBody = JSON.stringify(event);
  const oldTimestamp = Math.floor(Date.now() / 300) - 3000; // 300秒を大幅に超える
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET, oldTimestamp);

  const res = await postWebhookRaw(env, rawBody, sig);
  assert.equal(res.status, 400);
});

test('同一event_idのWebhookが2回来ても結果は1件（payment/entitlementとも）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_dup_1', sessionId });
  const rawBody = JSON.stringify(event);
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET);

  const res1 = await postWebhookRaw(env, rawBody, sig);
  const res2 = await postWebhookRaw(env, rawBody, sig); // 完全に同じリクエストを再送
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 1, 'paymentは1件のみ');
  assert.equal(entCount.c, 1, 'entitlementは1件のみ');
});

test('同一Checkout Session IDに対し異なるevent_idで2通届いても、結果は1件（Stripeの重複配信対策）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);

  const event1 = buildCheckoutSessionCompletedEvent({ eventId: 'evt_A', sessionId });
  const raw1 = JSON.stringify(event1);
  const sig1 = await signStripePayload(raw1, TEST_STRIPE_WEBHOOK_SECRET);
  await postWebhookRaw(env, raw1, sig1);

  const event2 = buildCheckoutSessionCompletedEvent({ eventId: 'evt_B', sessionId }); // event_idだけ違う
  const raw2 = JSON.stringify(event2);
  const sig2 = await signStripePayload(raw2, TEST_STRIPE_WEBHOOK_SECRET);
  const res2 = await postWebhookRaw(env, raw2, sig2);
  assert.equal(res2.status, 200);

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 1, 'stripe_checkout_session_id UNIQUE によりpaymentは1件のみ');
  assert.equal(entCount.c, 1);
});

test('payment_statusがpaid以外（非同期決済想定）の場合はentitlementを発行しない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_unpaid', sessionId, paymentStatus: 'unpaid' });
  const rawBody = JSON.stringify(event);
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET);

  const res = await postWebhookRaw(env, rawBody, sig);
  assert.equal(res.status, 200); // Stripeへは受理応答するが処理はしない
  const body = await res.json();
  assert.equal(body.ignored, 'not_paid_yet');

  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(entCount.c, 0, 'paid以外ではentitlementを発行しない（決済確認前生成禁止）');
});

test('未知のCheckout Session IDに対するWebhookは何も作らずに正常応答する', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_unknown', sessionId: 'cs_does_not_exist' });
  const rawBody = JSON.stringify(event);
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET);

  const res = await postWebhookRaw(env, rawBody, sig);
  assert.equal(res.status, 200);
  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  assert.equal(paymentCount.c, 0);
});

test('同時に同じイベントが競合して届いても（真の並行）payment/entitlementは1件のみ', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { sessionId } = await createIntentAndGetSessionId(env);
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_concurrent', sessionId });
  const rawBody = JSON.stringify(event);
  const sig = await signStripePayload(rawBody, TEST_STRIPE_WEBHOOK_SECRET);

  const [r1, r2] = await Promise.all([
    postWebhookRaw(env, rawBody, sig),
    postWebhookRaw(env, rawBody, sig),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 1);
  assert.equal(entCount.c, 1);
});
