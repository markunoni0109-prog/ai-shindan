import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken } from '../src/lib/tokens.js';
import { PLAN_CATALOG, isPurchasablePlan } from '../src/lib/plans.js';
import { claimEntitlement } from '../src/lib/db.js';
import { GENESIS_HASH, canonicalPayload, sha256Hex, combinationKey } from '../src/lib/engine.js';
import {
  signStripePayload, buildCheckoutSessionCompletedEvent, TEST_STRIPE_WEBHOOK_SECRET, makeFakeStripeFetch,
} from './stripeMock.js';

/**
 * 【正式料金仕様】5予測300円 / 10予測500円 / 30予測1,000円 / 50予測1,500円
 * （統括Open正式指示）。期待値はここに独立して書き下ろし、
 * カタログ(src/lib/plans.js)が仕様どおりであることを検証する。
 */
const SPEC = {
  pack5: { amount: 300, count: 5 },
  pack10: { amount: 500, count: 10 },
  pack30: { amount: 1000, count: 30 },
  pack50: { amount: 1500, count: 50 },
};

const req = (method, path, body) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

async function webhook(env, ev) {
  const raw = JSON.stringify(ev);
  const sig = await signStripePayload(raw, TEST_STRIPE_WEBHOOK_SECRET);
  return worker.fetch(new Request('http://localhost/api/stripe/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw,
  }), env);
}

/** Stripeへ実際に送られたunit_amount・metadataを捕捉できるenvを作る */
function envWithCapture(db) {
  const sent = [];
  const inner = makeFakeStripeFetch();
  const env = createTestEnv(db, {
    __testFetch: async (url, opts) => { sent.push(decodeURIComponent(String(opts.body))); return inner(url, opts); },
  });
  return { env, sent };
}

async function buy(env, planCode, { amountTotal, eventId } = {}) {
  const cr = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: planCode }), env);
  assert.equal(cr.status, 200);
  const body = await cr.json();
  const row = await env.DB.prepare('SELECT stripe_checkout_session_id AS s FROM purchase_intents WHERE claim_token_hash=?')
    .bind(await hashClaimToken(body.claim_token)).first();
  const ev = buildCheckoutSessionCompletedEvent({
    eventId: eventId || `evt_${row.s}`, sessionId: row.s,
    amountTotal: amountTotal ?? PLAN_CATALOG[planCode].amount, paymentIntentId: `pi_${row.s}`,
  });
  const wr = await webhook(env, ev);
  return { body, sessionId: row.s, event: ev, wr };
}
const claim = async (env, token) => (await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: token }), env)).json();

/** 全predictionsについてprevious_hash連鎖とrecord_hash再計算を検証する */
async function assertChainValid(db) {
  const rows = (await db.prepare(
    `SELECT p.*, pay.payment_public_id AS ppid, e.entitlement_public_id AS epid
       FROM predictions p JOIN payments pay ON pay.id=p.payment_id JOIN purchase_entitlements e ON e.id=p.entitlement_id
      ORDER BY p.display_sequence ASC`).all()).results;
  let prev = GENESIS_HASH;
  for (const r of rows) {
    assert.equal(r.previous_hash, prev, `display_sequence ${r.display_sequence}: previous_hashが直前のrecord_hash`);
    const recomputed = await sha256Hex(canonicalPayload({
      predictionId: r.prediction_id, drawNumber: r.draw_number,
      numbers: [r.number_1, r.number_2, r.number_3, r.number_4, r.number_5, r.number_6],
      generatedAt: r.generated_at, paymentPublicId: r.ppid, entitlementPublicId: r.epid,
      predictionIndex: r.prediction_index, planCode: r.plan_code, algorithmVersion: r.algorithm_version, previousHash: r.previous_hash,
    }));
    assert.equal(recomputed, r.record_hash, `display_sequence ${r.display_sequence}: record_hash再計算が一致`);
    prev = r.record_hash;
  }
  return rows;
}

// ---- QA 1-4: 商品仕様 ----
test('QA1-4: カタログは正式仕様どおり（5/300・10/500・30/1000・50/1500）で、購入可能プランはこの4つだけ', () => {
  for (const [code, spec] of Object.entries(SPEC)) {
    assert.equal(PLAN_CATALOG[code].amount, spec.amount, `${code}の金額`);
    assert.equal(PLAN_CATALOG[code].allowed_predictions, spec.count, `${code}の件数`);
    assert.equal(isPurchasablePlan(code), true);
  }
  const purchasable = Object.keys(PLAN_CATALOG).filter(isPurchasablePlan).sort();
  assert.deepEqual(purchasable, Object.keys(SPEC).sort());
});

test('販売終了・無料枠・未知のplan_codeはcheckout/createで400（Stripeへ送られない）', async () => {
  const db = createTestDb(); const { env, sent } = envWithCapture(db);
  for (const code of ['single', 'free', 'five', 'pack1', '']) {
    const r = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: code }), env);
    assert.equal(r.status, 400, `${code} は拒否`);
  }
  assert.equal(sent.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM purchase_intents').first()).c, 0);
});

for (const [code, spec] of Object.entries(SPEC)) {
  test(`${code}: ${spec.amount}円で${spec.count}件。Stripe送信金額一致・件数一致・全件保存・重複なし・hash chain正常・追跡全件登録`, async () => {
    const db = createTestDb(); const { env, sent } = envWithCapture(db);
    const { body, wr } = await buy(env, code);
    // QA5: Stripe送信金額一致（クライアントはamountを送っていない／サーバー固定）
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`\\[unit_amount\\]=${spec.amount}(&|$)`), 'Stripeへ送った金額（完全一致）');
    assert.ok(sent[0].includes('[currency]=jpy'));
    assert.ok(sent[0].includes(`plan_code]=${code}`));
    assert.equal(body.amount, spec.amount);
    assert.equal(body.allowed_predictions, spec.count);
    assert.equal(wr.status, 200);

    // QA6: 購入商品と生成件数一致
    const res = await claim(env, body.claim_token);
    assert.equal(res.outcome, 'created');
    assert.equal(res.predictions.length, spec.count);

    // QA10: 全件保存
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM predictions').first()).c, spec.count);
    const pay = await db.prepare('SELECT plan_code, amount FROM payments').first();
    assert.deepEqual({ ...pay }, { plan_code: code, amount: spec.amount });

    // QA11/12: prediction_id・combination_key・record_hash重複なし
    const rows = (await db.prepare('SELECT prediction_id, combination_key, record_hash, plan_code FROM predictions').all()).results;
    for (const k of ['prediction_id', 'combination_key', 'record_hash']) {
      assert.equal(new Set(rows.map((r) => r[k])).size, spec.count, `${k}重複なし`);
    }
    assert.ok(rows.every((r) => r.plan_code === code));
    for (const p of res.predictions) assert.equal(combinationKey(p.numbers), rows.find((r) => r.prediction_id === p.prediction_id).combination_key);

    // QA13: hash chain正常（再計算＋連鎖）
    await assertChainValid(db);

    // QA14: Permanent Tracking全件登録
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM prediction_generation_features').first()).c, spec.count);
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM prediction_tracking_summary').first()).c, spec.count);

    // entitlement: 全件消費・状態consumed
    const ent = await db.prepare('SELECT status, consumed_predictions, allowed_predictions FROM purchase_entitlements').first();
    assert.deepEqual({ ...ent }, { status: 'consumed', consumed_predictions: spec.count, allowed_predictions: spec.count });
  });
}

// ---- QA7/9: entitlement二重消費なし・claim再実行 ----
test('QA7/9: claim再実行は同じ予測を返し、並行claimでも二重消費・二重生成なし（5件のまま）', async () => {
  const db = createTestDb(); const env = createTestEnv(db);
  const { body } = await buy(env, 'pack5');
  const results = await Promise.all([1, 2, 3, 4].map(() => claim(env, body.claim_token)));
  const created = results.filter((r) => r.outcome === 'created').length;
  assert.ok(created <= 1, 'createdは高々1回');
  const ids = results.map((r) => r.predictions.map((p) => p.prediction_id).join(','));
  assert.equal(new Set(ids).size, 1, '全レスポンスが同一の5件');
  const again = await claim(env, body.claim_token);
  assert.equal(again.outcome, 'existing');
  assert.equal(again.predictions.length, 5);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM predictions').first()).c, 5);
  assert.equal((await db.prepare('SELECT consumed_predictions c FROM purchase_entitlements').first()).c, 5);
});

// ---- QA8: webhook重複 ----
for (const code of Object.keys(SPEC)) {
  test(`QA8: ${code} webhookを同一event_id・別event_id(同一session)で重複送信しても二重生成なし`, async () => {
    const db = createTestDb(); const env = createTestEnv(db);
    const { body, event, sessionId } = await buy(env, code);
    await webhook(env, event); // 同一event_id再送
    await webhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_other', sessionId, amountTotal: SPEC[code].amount, paymentIntentId: `pi_${sessionId}` })); // 別event
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM payments').first()).c, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM purchase_entitlements').first()).c, 1);
    await claim(env, body.claim_token); await claim(env, body.claim_token);
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM predictions').first()).c, SPEC[code].count);
  });
}

// ---- 金額検証：仕様と違う金額は発行しない ----
test('決済金額が仕様とずれていれば（1円差でも）購入権を発行しない', async () => {
  for (const [code, spec] of Object.entries(SPEC)) {
    for (const wrong of [spec.amount - 1, spec.amount + 1, 0]) {
      const db = createTestDb(); const env = createTestEnv(db);
      const { wr } = await buy(env, code, { amountTotal: wrong });
      assert.equal((await wr.json()).ignored, 'amount_mismatch', `${code}に${wrong}円`);
      assert.equal((await db.prepare('SELECT COUNT(*) c FROM purchase_entitlements').first()).c, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) c FROM predictions').first()).c, 0);
    }
  }
});

// ---- 部分生成禁止 ----
test('部分生成禁止：保存中に失敗すれば予測は0件・entitlementはactiveのまま（全体失敗）', async () => {
  for (const [code, spec] of [['pack5', SPEC.pack5], ['pack10', SPEC.pack10]]) {
    const db = createTestDb(); const env = createTestEnv(db);
    const { body } = await buy(env, code);
    const tokenHash = await hashClaimToken(body.claim_token);
    // 本来のINSERT群の後ろに必ず失敗する文を足し、バッチ全体のロールバックを検証する
    const failing = new Proxy(db, {
      get(t, k) {
        if (k === 'batch') return (stmts) => t.batch([...stmts, t.prepare('INSERT INTO __no_such_table__ VALUES (1)')]);
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await assert.rejects(() => claimEntitlement(failing, tokenHash, { drawNumber: 'PERMANENT_TRACKING' }));
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM predictions').first()).c, 0, `${code}: 部分保存なし`);
    assert.equal((await db.prepare('SELECT COUNT(*) c FROM prediction_generation_features').first()).c, 0);
    const ent = await db.prepare('SELECT status, consumed_predictions FROM purchase_entitlements').first();
    assert.deepEqual({ ...ent }, { status: 'active', consumed_predictions: 0 });
    // 失敗後に通常のclaimをやり直せば、ちょうどspec.count件で成功する
    const ok = await claim(env, body.claim_token);
    assert.equal(ok.predictions.length, spec.count);
    await assertChainValid(db);
  }
});

// ---- hash chain: 複数購入をまたいでも連続 ----
test('複数購入（5→10→30→50）をまたいでも全95件のhash chainが連続・正常', async () => {
  const db = createTestDb(); const env = createTestEnv(db);
  for (const code of ['pack5', 'pack10', 'pack30', 'pack50']) {
    const { body } = await buy(env, code);
    await claim(env, body.claim_token);
  }
  const rows = await assertChainValid(db);
  assert.equal(rows.length, 5 + 10 + 30 + 50);
  assert.equal(new Set(rows.map((r) => r.combination_key)).size, rows.length);
  assert.equal(new Set(rows.map((r) => r.prediction_id)).size, rows.length);
});

// ---- 不変性 ----
test('生成後のUPDATE/DELETEは5予測でも禁止のまま', async () => {
  const db = createTestDb(); const env = createTestEnv(db);
  const { body } = await buy(env, 'pack5'); await claim(env, body.claim_token);
  await assert.rejects(() => db.prepare('UPDATE predictions SET number_1 = number_1').run(), /immutable/);
  await assert.rejects(() => db.prepare('DELETE FROM predictions').run(), /immutable/);
});

// ---- 無料枠は影響を受けない ----
test('FREE PUBLIC BETAの無料枠(1予測/24h)は新料金の影響を受けず従来どおり1件', async () => {
  const db = createTestDb(); const env = createTestEnv(db);
  const r = await worker.fetch(req('POST', '/api/free/generate', { anon_id: 'anon-pricing-test-1' }), env);
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.equal(g.plan_code, 'free'); assert.equal(g.allowed_predictions, 1);
  const c = await claim(env, g.claim_token);
  assert.equal(c.predictions.length, 1);
});
