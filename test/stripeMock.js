/**
 * stripeMock.js
 * ------------------------------------------------------------------
 * Stripe本番課金は実行しない（指示どおり）。
 * ・Checkout Session作成はfetchをモックして「Stripeが返すであろう応答」を模倣する。
 * ・Webhookは、実際のStripe署名アルゴリズムと全く同じ計算で
 *   テスト用のStripe-Signatureヘッダーを生成し、本物の検証ロジック
 *   （src/lib/stripe.js の verifyStripeSignature）にそのまま通す。
 *   つまり「署名検証ロジック自体」は本物を使い、Stripeサーバーとの
 *   実通信だけをモックしている。
 * ------------------------------------------------------------------
 */

export const TEST_STRIPE_SECRET_KEY = 'sk_test_mock_0000000000000000000000';
export const TEST_STRIPE_WEBHOOK_SECRET = 'whsec_test_mock_0000000000000000';

let fakeSessionCounter = 0;

/** createCheckoutSession()内のfetch呼び出しを差し替えるモック */
export function makeFakeStripeFetch({ shouldFail = false } = {}) {
  return async function fakeFetch(url, options) {
    if (shouldFail) {
      return new Response(JSON.stringify({ error: { type: 'api_error', message: 'mock failure' } }), {
        status: 500,
      });
    }
    fakeSessionCounter += 1;
    const id = `cs_test_mock_${fakeSessionCounter}`;
    return new Response(
      JSON.stringify({ id, url: `https://checkout.stripe.com/mock/${id}` }),
      { status: 200 }
    );
  };
}

/** 本物と同じアルゴリズムでStripe-Signatureヘッダーを作る（テスト用） */
export async function signStripePayload(rawBody, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestampSeconds}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestampSeconds},v1=${hex}`;
}

/**
 * checkout.session.completed イベントのペイロードを組み立てる。
 * amountTotal未指定時は既存テスト（plan_code:'single'=300円）と
 * 互換性を保つため300をデフォルトにする。
 */
export function buildCheckoutSessionCompletedEvent({
  eventId,
  sessionId,
  paymentStatus = 'paid',
  paymentIntentId = 'pi_test_mock_1',
  amountTotal = 300,
  currency = 'jpy',
  customerEmail,
}) {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: paymentStatus,
        payment_intent: paymentIntentId,
        amount_total: amountTotal,
        currency,
        ...(customerEmail ? { customer_details: { email: customerEmail } } : {}),
      },
    },
  };
}
