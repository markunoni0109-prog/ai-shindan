import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStripeSignature, createCheckoutSession } from '../src/lib/stripe.js';
import { signStripePayload, TEST_STRIPE_WEBHOOK_SECRET, TEST_STRIPE_SECRET_KEY } from './stripeMock.js';

test('verifyStripeSignature: 正しい署名はvalid', async () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET);
  assert.equal(result.valid, true);
});

test('verifyStripeSignature: bodyを1文字変えると不一致になる', async () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET);
  const tampered = body.replace('evt_1', 'evt_2');
  const result = await verifyStripeSignature(tampered, sig, TEST_STRIPE_WEBHOOK_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('verifyStripeSignature: 違う秘密鍵で作った署名は不一致になる', async () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const sig = await signStripePayload(body, 'whsec_completely_different_secret');
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET);
  assert.equal(result.valid, false);
});

test('verifyStripeSignature: ヘッダーなし・形式不正はinvalid', async () => {
  const r1 = await verifyStripeSignature('{}', null, TEST_STRIPE_WEBHOOK_SECRET);
  assert.equal(r1.valid, false);
  assert.equal(r1.reason, 'missing_header');

  const r2 = await verifyStripeSignature('{}', 'garbage-header', TEST_STRIPE_WEBHOOK_SECRET);
  assert.equal(r2.valid, false);
  assert.equal(r2.reason, 'invalid_header');
});

test('createCheckoutSession: 呼び出し元が渡した金額・商品名でリクエストが組み立てられる（single=300円）', async () => {
  let capturedBody = null;
  let capturedAuth = null;
  const fakeFetch = async (url, options) => {
    capturedBody = options.body;
    capturedAuth = options.headers.Authorization;
    return new Response(JSON.stringify({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/mock/abc' }), {
      status: 200,
    });
  };

  const env = { STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY, __testFetch: fakeFetch };
  const result = await createCheckoutSession(env, {
    intentPublicId: 'intent_xyz',
    planCode: 'single',
    amount: 300,
    productName: 'LOTO6 AI PREDICTION（1予測）',
    successUrl: 'https://ai-hunter.jp/loto6/result/?session_id={CHECKOUT_SESSION_ID}#claim=abc',
    cancelUrl: 'https://ai-hunter.jp/loto6/',
  });

  assert.equal(result.id, 'cs_test_abc');
  assert.equal(capturedAuth, `Bearer ${TEST_STRIPE_SECRET_KEY}`);
  const decoded = decodeURIComponent(capturedBody.replace(/\+/g, ' '));
  assert.ok(decoded.includes('[unit_amount]=300'), '金額は呼び出し元(plan_code由来)の300円');
  assert.ok(decoded.includes('[quantity]=1'), '数量は常に1（金額側で合計を表現する）');
  assert.ok(decoded.includes('mode=payment'));
  assert.ok(decoded.includes('client_reference_id=intent_xyz'));
  assert.ok(!capturedBody.includes(TEST_STRIPE_SECRET_KEY), '秘密鍵がbodyに含まれていない（Authorizationヘッダーのみ）');
});

test('createCheckoutSession: pack50（15,000円・50予測）でも金額がそのまま渡る', async () => {
  let capturedBody = null;
  const fakeFetch = async (url, options) => {
    capturedBody = options.body;
    return new Response(JSON.stringify({ id: 'cs_test_pack50', url: 'https://checkout.stripe.com/mock/pack50' }), {
      status: 200,
    });
  };
  const env = { STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY, __testFetch: fakeFetch };
  await createCheckoutSession(env, {
    intentPublicId: 'intent_pack50',
    planCode: 'pack50',
    amount: 15000,
    productName: 'LOTO6 AI PREDICTION（50予測）',
    successUrl: 'https://ai-hunter.jp/loto6/result/?session_id={CHECKOUT_SESSION_ID}#claim=abc',
    cancelUrl: 'https://ai-hunter.jp/loto6/',
  });
  const decoded = decodeURIComponent(capturedBody.replace(/\+/g, ' '));
  assert.ok(decoded.includes('[unit_amount]=15000'));
  assert.ok(decoded.includes('[quantity]=1'));
  assert.ok(decoded.includes('metadata[plan_code]=pack50'));
});

test('createCheckoutSession: Stripe側エラー時は例外を投げ、詳細をそのまま漏らさない構造', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: { type: 'card_error', message: 'sensitive detail' } }), { status: 402 });
  const env = { STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY, __testFetch: fakeFetch };

  await assert.rejects(
    () =>
      createCheckoutSession(env, {
        intentPublicId: 'x',
        planCode: 'single',
        amount: 300,
        productName: 'x',
        successUrl: 'https://a',
        cancelUrl: 'https://b',
      }),
    (err) => {
      assert.ok(!err.message.includes('sensitive detail'));
      return true;
    }
  );
});
