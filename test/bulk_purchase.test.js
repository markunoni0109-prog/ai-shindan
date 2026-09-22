import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken, hashAccessToken } from '../src/lib/tokens.js';
import { PLAN_CATALOG } from '../src/lib/plans.js';
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

/** checkout/create → Webhook（正しいamount_total付き）まで一気通貫で行う */
async function purchasePlan(env, planCode, { amountTotalOverride } = {}) {
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: planCode }), env);
  assert.equal(createRes.status, 200, `checkout/create should succeed for ${planCode}`);
  const createBody = await createRes.json();

  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  const sessionId = intentRow.stripe_checkout_session_id;

  const amountTotal = amountTotalOverride ?? PLAN_CATALOG[planCode].amount;
  const event = buildCheckoutSessionCompletedEvent({
    eventId: `evt_${sessionId}`,
    sessionId,
    amountTotal,
    paymentIntentId: `pi_${sessionId}`, // 同一DB内で複数購入をテストするため一意にする
  });
  const webhookRes = await sendSignedWebhook(env, event);

  return { createBody, sessionId, webhookRes };
}

for (const [planCode, plan] of Object.entries(PLAN_CATALOG)) {
  test(`${planCode}: 価格(¥${plan.amount})でCheckout Sessionが作られ、金額はサーバー固定`, async () => {
    const db = createTestDb();
    const env = createTestEnv(db);
    const res = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: planCode, amount: 1 }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.amount, plan.amount, 'クライアント指定amountは無視され、カタログ値が使われる');
    assert.equal(body.allowed_predictions, plan.allowed_predictions);
    assert.ok(typeof body.claim_token === 'string' && body.claim_token.length > 0);
    assert.ok(typeof body.access_token === 'string' && body.access_token.length > 0);
    assert.notEqual(body.claim_token, body.access_token, 'claim_tokenとaccess_tokenは別の秘密');
  });

  test(`${planCode}: Webhook確定後、発行件数・D1保存件数がちょうど${plan.allowed_predictions}件`, async () => {
    const db = createTestDb();
    const env = createTestEnv(db);
    const { createBody, webhookRes } = await purchasePlan(env, planCode);
    assert.equal(webhookRes.status, 200);
    const webhookBody = await webhookRes.json();
    assert.equal(webhookBody.received, true);

    const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
    assert.equal(claimRes.status, 200);
    const claimBody = await claimRes.json();
    assert.equal(claimBody.outcome, 'created');
    assert.equal(claimBody.predictions.length, plan.allowed_predictions, 'レスポンスの発行件数');

    const dbCount = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
    assert.equal(dbCount.c, plan.allowed_predictions, 'D1への保存件数');

    // prediction_id重複なし・record_hash重複なし
    const ids = claimBody.predictions.map((p) => p.prediction_id);
    assert.equal(new Set(ids).size, ids.length, 'prediction_idはすべて一意');
    const hashes = claimBody.predictions.map((p) => p.record_hash);
    assert.equal(new Set(hashes).size, hashes.length, 'record_hashはすべて一意');

    // Permanent Tracking対象登録（features捕捉テーブルに全件登録される）
    const featCount = await db.prepare('SELECT COUNT(*) AS c FROM prediction_generation_features').first();
    assert.equal(featCount.c, plan.allowed_predictions, '全予測がPermanent Tracking(特徴量捕捉)対象');
  });
}

test('Webhook冪等性: まとめ買い(pack30)でも同一event_id再送で予測が二重生成されない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'pack30' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  const sessionId = intentRow.stripe_checkout_session_id;
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_pack30_dup', sessionId, amountTotal: 9000 });

  const res1 = await sendSignedWebhook(env, event);
  const res2 = await sendSignedWebhook(env, event); // 完全に同じWebhookを再送
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 1);
  assert.equal(entCount.c, 1);

  // claimも複数回叩いて、predictionsが30件のまま増えないことを確認
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  const predCount = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(predCount.c, 30, 'Webhook再送・claim再送を重ねても30件のまま（二重生成なし）');
});

test('決済金額検証: session.amount_totalがplan_codeの期待金額と食い違う場合は購入権を発行しない(fail-close)', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { webhookRes } = await purchasePlan(env, 'pack10', { amountTotalOverride: 300 }); // 3000円のはずが300円しか払われていない体
  assert.equal(webhookRes.status, 200, 'Stripeへは200を返す(再送を止めるため)');
  const webhookBody = await webhookRes.json();
  assert.equal(webhookBody.ignored, 'amount_mismatch');

  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  const entCount = await db.prepare('SELECT COUNT(*) AS c FROM purchase_entitlements').first();
  assert.equal(paymentCount.c, 0, '金額不一致ではpaymentを作らない');
  assert.equal(entCount.c, 0, '金額不一致ではentitlementを作らない(=予測も生成されない)');
});

test('決済金額検証: 通貨がjpy以外の場合も発行しない(fail-close)', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare(
    'SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?'
  )
    .bind(tokenHash)
    .first();
  const event = buildCheckoutSessionCompletedEvent({
    eventId: 'evt_wrong_currency',
    sessionId: intentRow.stripe_checkout_session_id,
    amountTotal: 300,
    currency: 'usd',
  });
  const res = await sendSignedWebhook(env, event);
  const body = await res.json();
  assert.equal(body.ignored, 'amount_mismatch');
  const paymentCount = await db.prepare('SELECT COUNT(*) AS c FROM payments').first();
  assert.equal(paymentCount.c, 0);
});

test('マイ予測: access_tokenで購入日時・件数・6数字・prediction_id・Permanent Tracking結果を再閲覧できる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody } = await purchasePlan(env, 'pack10');
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  const res = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.access_token }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.plan_code, 'pack10');
  assert.equal(body.amount, 3000);
  assert.equal(body.purchase_count, 10);
  assert.ok(typeof body.purchased_at === 'string' && body.purchased_at.length > 0, '購入日時が含まれる');
  assert.equal(body.predictions.length, 10);
  for (const p of body.predictions) {
    assert.equal(p.numbers.length, 6);
    assert.ok(typeof p.prediction_id === 'string');
    assert.ok('tracking' in p, 'Permanent Tracking結果が含まれる');
    assert.ok(typeof p.tracking.checked_draw_count === 'number');
  }
});

test('マイ予測: 再閲覧は何度でもでき、内容は都度D1から一致した結果が返る（localStorage前提ではない）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody } = await purchasePlan(env, 'single');
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  const res1 = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.access_token }), env);
  const res2 = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.access_token }), env);
  const body1 = await res1.json();
  const body2 = await res2.json();
  assert.deepEqual(body1, body2, '同じaccess_tokenなら何度呼んでも同じ結果');
});

test('マイ予測: 他人の購入へは推測・列挙でアクセスできない（存在しないtoken・でたらめなtokenは404）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const resInvalid = await worker.fetch(
    req('POST', '/api/my-predictions', { access_token: 'totally-made-up-token' }),
    env
  );
  assert.equal(resInvalid.status, 404);
  const bodyInvalid = await resInvalid.json();
  assert.ok(!JSON.stringify(bodyInvalid).match(/SELECT|sqlite|stack|SQLITE_/i), '内部情報を漏らさない');
});

test('マイ予測: claim_tokenをaccess_tokenとして渡しても他人の予測は見えない（トークン種別の取り違え防止）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody } = await purchasePlan(env, 'single');
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  // claim_tokenの平文をそのままaccess_tokenとして送っても、
  // ハッシュが一致するのはaccess_token_hash列だけなので通らない。
  const res = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.claim_token }), env);
  assert.equal(res.status, 404);
});

test('マイ予測: 別の購入者(別access_token)からは互いの予測が見えない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const purchaseA = await purchasePlan(env, 'single');
  const purchaseB = await purchasePlan(env, 'pack10');
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: purchaseA.createBody.claim_token }), env);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: purchaseB.createBody.claim_token }), env);

  const resA = await worker.fetch(
    req('POST', '/api/my-predictions', { access_token: purchaseA.createBody.access_token }),
    env
  );
  const bodyA = await resA.json();
  assert.equal(bodyA.purchase_count, 1, 'Aは自分の1件しか見えない');

  const resB = await worker.fetch(
    req('POST', '/api/my-predictions', { access_token: purchaseB.createBody.access_token }),
    env
  );
  const bodyB = await resB.json();
  assert.equal(bodyB.purchase_count, 10, 'Bは自分の10件しか見えない');

  const idsA = new Set(bodyA.predictions.map((p) => p.prediction_id));
  const idsB = new Set(bodyB.predictions.map((p) => p.prediction_id));
  for (const id of idsA) assert.ok(!idsB.has(id), 'AとBの予測は重複しない');
});

test('QAモード安全性: フロントの?qa=1相当のパラメータをサーバーAPIへ送っても本番決済扱いされない特別扱いは無い（サーバー側にqaバイパスを実装していないことの確認）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  // qa=1やtest=1等の余計なフィールドを付けても、plan_code以外は無視され、
  // 通常の本番Checkout Session作成と同じ経路にしかならないことを確認する
  // （サーバー側に「QA用に決済をスキップする」特別分岐が存在しないことの検証）。
  const res = await worker.fetch(
    req('POST', '/api/checkout/create', { plan_code: 'single', qa: 1, test: true }),
    env
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.checkout_url.startsWith('https://checkout.stripe.com/'), '常に本物のCheckout Session URLが返る');
});

test('既存300円1予測の回帰テスト: 従来どおり1件生成・claim・historyに反映される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const { createBody, webhookRes } = await purchasePlan(env, 'single');
  assert.equal(webhookRes.status, 200);

  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  const claimBody = await claimRes.json();
  assert.equal(claimBody.outcome, 'created');
  assert.equal(claimBody.predictions.length, 1);

  const histRes = await worker.fetch(req('GET', '/api/history'), env);
  const histBody = await histRes.json();
  assert.equal(histBody.predictions.length, 1);
  assert.equal(histBody.predictions[0].prediction_id, claimBody.predictions[0].prediction_id);

  const dbCount = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(dbCount.c, 1);
});

test('不正なplan_codeは引き続き400', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'pack999' }), env);
  assert.equal(res.status, 400);
});
