/**
 * stripe.js
 * ------------------------------------------------------------------
 * Stripe REST APIを直接fetch()で呼ぶ（Node向けstripe SDKは使わない。
 * Workers環境での動作実績が薄く、依存を増やしたくないため）。
 * Webhook署名検証もStripeの公式アルゴリズムを手動実装する
 * （HMAC-SHA256 over "{timestamp}.{rawBody}"、tolerance=300秒）。
 *
 * 秘密鍵（env.STRIPE_SECRET_KEY / env.STRIPE_WEBHOOK_SECRET）は
 * Cloudflare Worker Secretsとして人間が設定する前提。コード内に
 * 値を書かない。
 * ------------------------------------------------------------------
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** application/x-www-form-urlencoded 形式にネストしたオブジェクトを変換する */
function toFormBody(params, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      pairs.push(...toFormBodyEntries(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          pairs.push(...toFormBodyEntries(item, `${fullKey}[${i}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else {
      pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return pairs;
}

function toFormBodyEntries(obj, prefix) {
  return toFormBody(obj, prefix);
}

function encodeForm(params) {
  return toFormBody(params).join('&');
}

export async function createCheckoutSession(
  env,
  { intentPublicId, successUrl, cancelUrl }
) {
  const fetchImpl = env.__testFetch || fetch;
  const body = encodeForm({
    mode: 'payment',
    client_reference_id: intentPublicId,
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'jpy',
    'line_items[0][price_data][unit_amount]': 300,
    'line_items[0][price_data][product_data][name]': 'LOTO6 AI PREDICTION（1予測）',
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { intent_public_id: intentPublicId },
  });

  const res = await fetchImpl(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `loto6-checkout-${intentPublicId}`,
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`stripe_checkout_session_create_failed:${data?.error?.type || 'unknown'}`);
  }

  return { id: data.id, url: data.url };
}

export async function verifyStripeSignature(rawBody, sigHeader, secret, now = Date.now()) {
  if (!sigHeader) return { valid: false, reason: 'missing_header' };

  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    })
  );

  const timestamp = parts.t;
  const v1 = parts.v1;

  if (!timestamp || !v1) {
    return { valid: false, reason: 'invalid_header' };
  }

  const nowSeconds = Math.floor(now / 1000);

  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_expired' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );

  const expectedHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const valid = timingSafeEqualHex(expectedHex, v1);

  return valid
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}
