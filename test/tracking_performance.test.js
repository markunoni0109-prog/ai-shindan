import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken } from '../src/lib/tokens.js';
import { backfillPrediction, matchPredictionToDraw } from '../src/lib/tracking.js';
import { signStripePayload, buildCheckoutSessionCompletedEvent, TEST_STRIPE_WEBHOOK_SECRET } from './stripeMock.js';

/**
 * 【50件時のD1処理の性能確認・最小修正の検証】
 *
 * 元の実装は、claim時に1予測ごとbackfillPrediction()を呼び、その中で
 * 過去抽選回数ぶんmatchPredictionToDraw()を1件ずつawaitしていた
 * （1回あたりSELECT/INSERT/UPSERTが複数回発生）。LOTO6は2000年開始・
 * 週2回転開で本番では既に2000回超の抽選実績があり、まとめ買い
 * (最大50予測)のclaim時には「50予測 × 2000回超の抽選 × 複数回のawait」
 * が直列に発生し、Cloudflare Workersのリクエストタイムアウトに抵触し
 * 得る設計だった。
 *
 * ここではbackfillPrediction()を「INSERTをbatch()でまとめ、summary再計算は
 * 1回だけ」に書き換えた（matchPredictionToDraw自体・processDraw経路は無変更）。
 * このテストは (a) 出力がmatchPredictionToDrawを逐次呼んだ場合と完全に
 * 一致すること、(b) 本番相当の抽選件数(1800件=年104回×約17年+α)×50予測の
 * claimが現実的な時間で完走し、部分保存が起きないことを確認する。
 */

function seedDraws(db, count) {
  // 2000-10-05(LOTO6実際の第1回)を起点に、本番相当の抽選件数を機械的に生成する。
  const stmt = db.prepare(
    `INSERT INTO lottery_draws(draw_id,draw_number,draw_date,n1,n2,n3,n4,n5,n6,bonus_number,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  );
  const start = Date.UTC(2000, 9, 5);
  for (let i = 1; i <= count; i++) {
    const nums = new Set();
    let seed = i;
    while (nums.size < 6) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      nums.add((seed % 43) + 1);
    }
    const sorted = Array.from(nums).sort((a, b) => a - b);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const bonus = (seed % 43) + 1;
    const dateStr = new Date(start + i * 3.4 * 86400000).toISOString().slice(0, 10);
    stmt.bind(`d${i}`, i, dateStr, ...sorted, bonus, 'synthetic-perf-test').run();
  }
}

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
    new Request('http://localhost/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: rawBody }),
    env
  );
}

test('backfillPrediction(新実装)はmatchPredictionToDrawを逐次呼んだ場合と完全に同じ行を残す', async () => {
  const db = createTestDb();
  seedDraws(db, 120);
  await db.prepare(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay1','single',300,'jpy','paid')`).run();
  await db.prepare(`INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id) VALUES('i1','single','th1','fulfilled',1)`).run();
  await db.prepare(`INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,status,claim_token_hash) VALUES('e1',1,1,1,'consumed','th2')`).run();
  const insertPred = (id, seq, combinationKey) =>
    db
      .prepare(
        `INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash) VALUES(?,?,'PERMANENT_TRACKING',6,13,14,29,33,38,?,'2026-09-20T11:16:00.000Z',1,1,?,'single','v1',?,?)`
      )
      .bind(id, seq, combinationKey, seq, seq === 1 ? 'GENESIS' : 'h1', seq === 1 ? 'h1' : 'h2')
      .run();
  await insertPred('pNew', 1, '06-13-14-29-33-38-A'); // 新実装(batch)で処理
  await insertPred('pRef', 2, '06-13-14-29-33-38-B'); // 参照実装(逐次matchPredictionToDraw)で処理

  await backfillPrediction(db, 'pNew');

  const draws = await db.prepare('SELECT * FROM lottery_draws ORDER BY draw_date,draw_number').all();
  for (const d of draws.results) await matchPredictionToDraw(db, { prediction_id: 'pRef', generated_at: '2026-09-20T11:16:00.000Z', number_1: 6, number_2: 13, number_3: 14, number_4: 29, number_5: 33, number_6: 38 }, d);

  const rowsNew = await db.prepare(`SELECT draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws FROM prediction_matches WHERE prediction_id='pNew' ORDER BY draw_id`).all();
  const rowsRef = await db.prepare(`SELECT draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws FROM prediction_matches WHERE prediction_id='pRef' ORDER BY draw_id`).all();
  assert.deepEqual(rowsNew.results, rowsRef.results, 'batch実装と逐次実装でprediction_matchesの内容が完全一致');

  const sNew = await db.prepare(`SELECT checked_draw_count,best_main_match_count,best_bonus_match,best_equivalent_rank,best_draw_id,days_to_best,draws_to_best,first_3plus_draw_id FROM prediction_tracking_summary WHERE prediction_id='pNew'`).first();
  const sRef = await db.prepare(`SELECT checked_draw_count,best_main_match_count,best_bonus_match,best_equivalent_rank,best_draw_id,days_to_best,draws_to_best,first_3plus_draw_id FROM prediction_tracking_summary WHERE prediction_id='pRef'`).first();
  assert.deepEqual(sNew, sRef, 'summaryもbatch実装と逐次実装で完全一致');
});

test('backfillPredictionは同じpredictionに対して複数回呼んでも冪等（二重INSERTされない）', async () => {
  const db = createTestDb();
  seedDraws(db, 30);
  await db.prepare(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay1','single',300,'jpy','paid')`).run();
  await db.prepare(`INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id) VALUES('i1','single','th1','fulfilled',1)`).run();
  await db.prepare(`INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,status,claim_token_hash) VALUES('e1',1,1,1,'consumed','th2')`).run();
  await db
    .prepare(
      `INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash) VALUES('p1',1,'PERMANENT_TRACKING',6,13,14,29,33,38,'06-13-14-29-33-38','2026-09-20T11:16:00.000Z',1,1,1,'single','v1','GENESIS','h1')`
    )
    .run();

  await backfillPrediction(db, 'p1');
  await backfillPrediction(db, 'p1');
  await backfillPrediction(db, 'p1');

  const c = await db.prepare(`SELECT COUNT(*) c FROM prediction_matches WHERE prediction_id='p1'`).first();
  assert.equal(c.c, 30, '抽選件数ぶんのまま増えない（重複INSERTなし）');
  const summaries = await db.prepare(`SELECT COUNT(*) c FROM prediction_tracking_summary WHERE prediction_id='p1'`).first();
  assert.equal(summaries.c, 1, 'summaryも1行のまま（UPSERT）');
});

test('本番相当(抽選1800回)×pack50(50予測)のclaimが現実的な時間で完走し、50件とも部分保存なくPermanent Tracking登録される', async () => {
  const db = createTestDb();
  seedDraws(db, 1800); // 週2回転開×約17年半相当（本番の抽選実績規模の目安として仮定。実数は未確認）
  const env = createTestEnv(db);

  const createRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'pack50' }), env);
  const createBody = await createRes.json();
  const tokenHash = await hashClaimToken(createBody.claim_token);
  const intentRow = await env.DB.prepare('SELECT stripe_checkout_session_id FROM purchase_intents WHERE claim_token_hash=?').bind(tokenHash).first();
  const sessionId = intentRow.stripe_checkout_session_id;
  const event = buildCheckoutSessionCompletedEvent({ eventId: 'evt_perf_pack50', sessionId, amountTotal: 15000, paymentIntentId: `pi_${sessionId}` });
  await sendSignedWebhook(env, event);

  const t0 = Date.now();
  const claimRes = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: createBody.claim_token }), env);
  const elapsedMs = Date.now() - t0;
  assert.equal(claimRes.status, 200, 'タイムアウト・エラーなくclaimが完了する');
  const claimBody = await claimRes.json();
  assert.equal(claimBody.predictions.length, 50, '部分保存なく50件とも返る');

  const predCount = await db.prepare('SELECT COUNT(*) c FROM predictions').first();
  assert.equal(predCount.c, 50, 'D1にも50件とも保存されている（部分保存なし）');

  const summaryCount = await db.prepare('SELECT COUNT(*) c FROM prediction_tracking_summary').first();
  assert.equal(summaryCount.c, 50, '50件ともPermanent Tracking初期化済み');

  const matchCount = await db.prepare('SELECT COUNT(*) c FROM prediction_matches').first();
  assert.equal(matchCount.c, 50 * 1800, '50予測×1800抽選ぶんの照合結果がすべて保存されている');

  console.log(`[perf] pack50 claim (predictions=50, draws=1800) elapsed=${elapsedMs}ms`);
  // Cloudflare Workersの標準リクエストタイムアウト(数十秒オーダー)に対し、
  // 十分な余裕をもって完走することを確認する（テスト環境はnode:sqlite・
  // インメモリDBのため実際のD1ネットワーク往復より高速だが、
  // 「予測数×抽選回数に比例して直列awaitが積み上がる」設計上の問題が
  // 解消されたことのアルゴリズム的な確認として有効）。
  assert.ok(elapsedMs < 15000, `想定時間内(15秒)で完走する: ${elapsedMs}ms`);
});
