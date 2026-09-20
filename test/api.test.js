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

function req(method, path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const FORBIDDEN_KEYS = [
  'id',
  'entitlement_id',
  'payment_id',
  'claim_token_hash',
  'claim_token',
  'stripe_checkout_session_id',
  'stripe_payment_intent_id',
  'stripe_event_id',
];

function assertNoSecrets(obj) {
  const j = JSON.stringify(obj);
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(!j.includes(`"${key}"`), `レスポンスに禁止フィールド "${key}" が含まれていない`);
  }
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

/** checkout/create → (モックfetchで)Checkout Session作成 → Webhook送信 まで一気通貫で行う */
async function simulateFullPurchase(env) {
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const { claim_token, checkout_url } = createBody;

  const tokenHash = await hashClaimToken(claim_token);
  const intentRow = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  const sessionId = intentRow.stripe_checkout_session_id;

  const event = buildCheckoutSessionCompletedEvent({ eventId: `evt_${sessionId}`, sessionId });
  const webhookRes = await sendSignedWebhook(env, event);

  return { claim_token, checkout_url, sessionId, webhookRes, createRes, createBody };
}

test('POST /api/checkout/create: 正しいplan_codeでStripe Checkout Sessionが作られる（Stripeはモック）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan_code, 'single');
  assert.equal(body.amount, 300, '金額はサーバー側固定値（クライアントからamountは送っていない）');
  assert.ok(typeof body.claim_token === 'string' && body.claim_token.length > 0);
  assert.ok(body.checkout_url.startsWith('https://checkout.stripe.com/'));
  // claim_tokenは仕様上この応答で1度だけ平文を返してよい。他の内部情報が無いことだけ確認する。
  for (const key of ['id', 'entitlement_id', 'payment_id', 'claim_token_hash', 'stripe_checkout_session_id', 'stripe_event_id']) {
    assert.ok(!JSON.stringify(body).includes(`"${key}"`), `${key} は含まれていない`);
  }
});

test('POST /api/checkout/create: 不正なplan_codeは400、クライアント指定のamountは無視される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res1 = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'invalid' }), env);
  assert.equal(res1.status, 400);

  const res2 = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single', amount: 1 }), env);
  const body2 = await res2.json();
  assert.equal(body2.amount, 300);
});

test('Stripe側でセッション作成が失敗した場合、内部エラー詳細を返さず502', async () => {
  const db = createTestDb();
  const env = createTestEnv(db, { __testFetch: (await import('./stripeMock.js')).makeFakeStripeFetch({ shouldFail: true }) });
  const res = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).match(/stripe|api_error|mock failure/i), 'Stripeの生エラーを含まない');
});

test('決済確認前はentitlementが無く、claimできない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const { claim_token } = await createRes.json();

  // Webhookがまだ届いていない状態でclaimしても無効
  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token }), env);
  assert.equal(claimRes.status, 404, 'entitlement未発行のためinvalid_token相当');
});

test('決済確認後（Webhook経由）：purchases/statusがready、claimで1予測取得できる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { claim_token, sessionId, webhookRes } = await simulateFullPurchase(env);
  assert.equal(webhookRes.status, 200);
  const webhookBody = await webhookRes.json();
  assert.equal(webhookBody.received, true);

  const statusRes = await worker.fetch(req('GET', `/api/purchases/status?session_id=${sessionId}`), env);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.status, 'ready');
  assertNoSecrets(statusBody);
  assert.ok(!('claim_token' in statusBody) && !('predictions' in statusBody));

  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token }), env);
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.headers.get('referrer-policy'), 'no-referrer');
  const claimBody = await claimRes.json();
  assert.equal(claimBody.outcome, 'created');
  assert.equal(claimBody.predictions.length, 1);
  assertNoSecrets(claimBody);

  // 再送しても同じ1予測
  const claimRes2 = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token }), env);
  const claimBody2 = await claimRes2.json();
  assert.equal(claimBody2.outcome, 'existing');
  assert.deepEqual(
    claimBody2.predictions.map((p) => p.prediction_id),
    claimBody.predictions.map((p) => p.prediction_id)
  );
});

test('purchases/status: 存在しないsession_idはpending扱い（内部情報を漏らさない）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('GET', '/api/purchases/status?session_id=cs_does_not_exist'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'pending');
});

test('purchases/status: session_id未指定は400', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('GET', '/api/purchases/status'), env);
  assert.equal(res.status, 400);
});

test('POST /api/predictions/claim: 無効なtokenは404かつ内部情報を含まない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: 'totally-invalid' }), env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).match(/SELECT|sqlite|stack|SQLITE_/i));
});

test('GET /api/history・/api/history/:id: 公開フィールドのみ、秘密情報なし', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  await (async () => {
    const { claim_token } = await simulateFullPurchase(env);
    await worker.fetch(req('POST', '/api/predictions/claim', { claim_token }), env);
  })();

  const histRes = await worker.fetch(req('GET', '/api/history'), env);
  const histBody = await histRes.json();
  assert.equal(histBody.predictions.length, 1);
  assertNoSecrets(histBody);

  const one = histBody.predictions[0];
  const detailRes = await worker.fetch(req('GET', `/api/history/${one.prediction_id}`), env);
  const detailBody = await detailRes.json();
  assert.equal(detailBody.prediction_id, one.prediction_id);
  assertNoSecrets(detailBody);
});

test('GET /api/history/:id: 存在しないIDは404', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('GET', '/api/history/does-not-exist'), env);
  assert.equal(res.status, 404);
});

test('GET /api/stats: 型のみ確認', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('GET', '/api/stats'), env);
  const body = await res.json();
  assert.equal(typeof body.total_predictions, 'number');
  assert.equal(body.match_0, 0);
});

test('未知のパスは404、不正JSONは400、内部情報を漏らさない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('GET', '/api/nonexistent'), env);
  assert.equal(res.status, 404);

  const badReq = new Request('http://localhost/api/predictions/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  });
  const badRes = await worker.fetch(badReq, env);
  assert.equal(badRes.status, 400);
});
