import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken, hashAccessToken } from '../src/lib/tokens.js';
import {
  signStripePayload,
  buildCheckoutSessionCompletedEvent,
  TEST_STRIPE_WEBHOOK_SECRET,
} from './stripeMock.js';

/**
 * 【購入者は予測をずっと見られる：localStorage消失・端末変更時の復旧】
 *
 * access_tokenのlocalStorage保持だけに依存させないため、Stripe Checkoutが
 * 収集したメールアドレス(customer_details.email)をハッシュ化して記録し、
 * (1)そのメールへ復旧用のワンタイムリンクを送る→(2)そのリンクを踏むと
 * 新しいaccess_tokenが発行される、という2段階の復旧フローを追加した。
 *
 * 確認する安全性：
 *  - メールアドレスの実在確認にならない（存在しなくても同じ応答）
 *  - 復旧トークンは単回使用・期限切れ後は使えない
 *  - D1が正本（access_tokenは新規発行され、旧トークンは失効する）
 *  - 他人のメールアドレスでは他人の購入は復旧できない
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

function testEnv(db, overrides = {}) {
  const sentEmails = [];
  const env = createTestEnv(db, {
    EMAIL_HASH_SECRET: 'test-email-hash-secret-do-not-use-in-prod',
    __testEmailSender: async (msg) => {
      sentEmails.push(msg);
      return { sent: true };
    },
    ...overrides,
  });
  return { env, sentEmails };
}

test('復旧メール発行→リンク引き換えで新しいaccess_tokenが発行され、マイ予測が見られる', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);

  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  const event = buildCheckoutSessionCompletedEvent({
    eventId: 'evt_recovery_1',
    sessionId,
    amountTotal: 300,
    paymentIntentId: `pi_${sessionId}`,
    customerEmail: 'buyer@example.com',
  });
  const webhookRes = await sendSignedWebhook(env, event);
  assert.equal(webhookRes.status, 200);
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  // 端末変更でlocalStorageを失った想定：元のaccess_tokenは使わず、メールだけで復旧する。
  const recoverRes = await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'buyer@example.com' }), env);
  assert.equal(recoverRes.status, 200);
  assert.equal(sentEmails.length, 1, '該当する購入があるので復旧メールが1通送られる');
  const linkMatch = sentEmails[0].text.match(/recover=([^\s]+)/);
  assert.ok(linkMatch, 'メール本文に復旧リンクが含まれる');
  const recoveryToken = decodeURIComponent(linkMatch[1]);

  const redeemRes = await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);
  assert.equal(redeemRes.status, 200);
  const redeemBody = await redeemRes.json();
  assert.equal(redeemBody.payments.length, 1);
  const newAccessToken = redeemBody.payments[0].access_token;
  assert.notEqual(newAccessToken, createBody.access_token, '復旧では新しいaccess_tokenが発行される（元のトークンは返せない）');

  const myPredRes = await worker.fetch(req('POST', '/api/my-predictions', { access_token: newAccessToken }), env);
  assert.equal(myPredRes.status, 200);
  const myPredBody = await myPredRes.json();
  assert.equal(myPredBody.plan_code, 'single');
  assert.equal(myPredBody.purchase_count, 1);
});

test('復旧トークンのローテーションにより、古いaccess_tokenは復旧後に無効になる', async () => {
  const db = createTestDb();
  const { env } = testEnv(db);

  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_rot_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}`, customerEmail: 'rotate@example.com' }));
  await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);

  // 復旧前は元のaccess_tokenで見られる
  const beforeRes = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.access_token }), env);
  assert.equal(beforeRes.status, 200);

  const sent = [];
  env.__testEmailSender = async (msg) => { sent.push(msg); return { sent: true }; };
  await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'rotate@example.com' }), env);
  assert.equal(sent.length, 1);
  const recoveryToken = decodeURIComponent(sent[0].text.match(/recover=([^\s]+)/)[1]);

  await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);

  // 復旧後は古いaccess_tokenでは見られなくなる（ローテーション済み）
  const afterRes = await worker.fetch(req('POST', '/api/my-predictions', { access_token: createBody.access_token }), env);
  assert.equal(afterRes.status, 404, '復旧によって古いaccess_tokenは失効する');
});

test('存在しないメールアドレスでも同じ応答（列挙対策）でメールは送られない', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);
  const res = await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'nobody@example.com' }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.message);
  assert.equal(sentEmails.length, 0, '該当する購入が無いので実際にはメールを送らない');
});

test('不正な形式のメールアドレスは400（列挙とは無関係な入力検証）', async () => {
  const db = createTestDb();
  const { env } = testEnv(db);
  const res = await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'not-an-email' }), env);
  assert.equal(res.status, 400);
});

test('復旧トークンは単回使用（2回目のredeemは404）', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_once_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}`, customerEmail: 'once@example.com' }));

  await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'once@example.com' }), env);
  const recoveryToken = decodeURIComponent(sentEmails[0].text.match(/recover=([^\s]+)/)[1]);

  const res1 = await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);
  assert.equal(res1.status, 200);
  const res2 = await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);
  assert.equal(res2.status, 404, '同じrecovery_tokenを2回使うことはできない');
});

test('期限切れの復旧トークンは404（内部エラー詳細は漏らさない）', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_exp_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}`, customerEmail: 'expired@example.com' }));

  await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'expired@example.com' }), env);
  const recoveryToken = decodeURIComponent(sentEmails[0].text.match(/recover=([^\s]+)/)[1]);

  // 有効期限を過去に書き換えて期限切れを再現する
  await db.prepare(`UPDATE recovery_requests SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
  const res = await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).match(/SELECT|sqlite|stack|SQLITE_/i));
});

test('同じメールで複数購入していれば、復旧で全購入分の新access_tokenがまとめて発行される', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);
  const email = 'multi@example.com';

  for (const planCode of ['single', 'pack10']) {
    const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: planCode }), env);
    const createBody = await createRes.json();
    const tokenHash = await hashClaimToken(createBody.claim_token);
    const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
    const sessionId = intentRow.stripe_checkout_session_id;
    const amountTotal = planCode === 'single' ? 300 : 3000;
    await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: `evt_multi_${planCode}`, sessionId, amountTotal, paymentIntentId: `pi_${sessionId}`, customerEmail: email }));
    await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  }

  await worker.fetch(req('POST', '/api/my-predictions/recover', { email }), env);
  const recoveryToken = decodeURIComponent(sentEmails[0].text.match(/recover=([^\s]+)/)[1]);
  const redeemRes = await worker.fetch(req('POST', '/api/my-predictions/recover/redeem', { recovery_token: recoveryToken }), env);
  const redeemBody = await redeemRes.json();
  assert.equal(redeemBody.payments.length, 2, '同じメールの2件の購入とも新トークンが発行される');

  for (const p of redeemBody.payments) {
    const res = await worker.fetch(req('POST', '/api/my-predictions', { access_token: p.access_token }), env);
    assert.equal(res.status, 200, `${p.plan_code}の新access_tokenで正しく閲覧できる`);
  }
});

test('他人のメールアドレスでは他人の購入を復旧できない', async () => {
  const db = createTestDb();
  const { env, sentEmails } = testEnv(db);

  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_owner_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}`, customerEmail: 'owner@example.com' }));

  const res = await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'attacker@example.com' }), env);
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 0, '別人のメールアドレスでは何も一致せずメールも送られない');
});

test('メール未収集(customer_details無し)の決済でも、既存の決済・予測発行フローには一切影響しない', async () => {
  const db = createTestDb();
  const { env } = testEnv(db);
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  // customerEmailを指定しない（従来どおりのイベント）
  const webhookRes = await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_noemail_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}` }));
  assert.equal(webhookRes.status, 200);
  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  assert.equal(claimRes.status, 200);
  const claimBody = await claimRes.json();
  assert.equal(claimBody.predictions.length, 1, 'メール未収集でも予測は通常どおり発行される');

  const row = await db.prepare(`SELECT customer_email_hash FROM payments WHERE id = 1`).first();
  assert.equal(row.customer_email_hash, null);
});

test('EMAIL_HASH_SECRET未設定でも、既存の決済・予測発行フローには一切影響しない（復旧機能だけ静かに無効）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db); // EMAIL_HASH_SECRET・__testEmailSenderともに未設定
  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  const webhookRes = await sendSignedWebhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_nosecret_1', sessionId, amountTotal: 300, paymentIntentId: `pi_${sessionId}`, customerEmail: 'x@example.com' }));
  assert.equal(webhookRes.status, 200, 'EMAIL_HASH_SECRET未設定でもWebhook処理自体は失敗しない');
  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  assert.equal(claimRes.status, 200);

  const recoverRes = await worker.fetch(req('POST', '/api/my-predictions/recover', { email: 'x@example.com' }), env);
  assert.equal(recoverRes.status, 200, '復旧機能自体はEMAIL_HASH_SECRET未設定でも200を返す(列挙対策と同じ静かな失敗)');
});
