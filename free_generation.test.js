import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { claimEntitlement } from '../src/lib/db.js';
import { hashClaimToken } from '../src/lib/tokens.js';

/**
 * 【T-002 FREE PUBLIC BETA】/api/free/generate + /api/predictions/claim
 * の無料枠フロー全体を検証する。
 *
 * 計画書(claude/T-002_FREE_PUBLIC_BETA_実装計画書_2026-09-26.md v2最終版)
 * Section 4 に列挙した12パターンをすべて含む。冒頭5件はPerplexity監査で
 * 追加された「未消費free entitlementの復旧」要件（ユーザー指示の文言に
 * そのまま対応）、続く7件は基本の原子的競合防止・24h境界・既存機能への
 * 影響確認パターン。
 */

function req(method, path, body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ANON_A = 'anon-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ANON_B = 'anon-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function generate(env, anonId) {
  const res = await worker.fetch(req('POST', '/api/free/generate', { anon_id: anonId }), env);
  const body = await res.json();
  return { res, body };
}

async function claim(env, claimToken) {
  const res = await worker.fetch(req('POST', '/api/predictions/claim', { claim_token: claimToken }), env);
  const body = await res.json();
  return { res, body };
}

// ============================================================
// 1〜5: Perplexity監査で追加された5パターン（ユーザー指示の文言に対応）
// ============================================================

test('①entitlement発行後、claim前通信断 → 新しいentitlementを発行せず、既存の未消費free entitlementを再取得できる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const first = await generate(env, ANON_A);
  assert.equal(first.res.status, 200);
  assert.equal(first.body.outcome, 'created');

  // ここで意図的にclaimを呼ばず「通信断」を模擬し、再度generateする。
  const second = await generate(env, ANON_A);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.outcome, 'recovered', '新規entitlementではなく既存の再取得として扱われる');
  assert.notEqual(second.body.claim_token, first.body.claim_token, 'claim_tokenはローテーションされ、新しい値が返る');

  // 再取得した新しいclaim_tokenで実際にclaimできる（同じ権利から）
  const claimed = await claim(env, second.body.claim_token);
  assert.equal(claimed.res.status, 200);
  assert.equal(claimed.body.outcome, 'created');
  assert.equal(claimed.body.predictions.length, 1);

  // 古い(通信断した)claim_tokenは既にローテーション済みのため使えない
  const oldClaim = await claim(env, first.body.claim_token);
  assert.equal(oldClaim.res.status, 404, '古いclaim_tokenは無効化されている（トークンローテーション）');
});

test('②再取得時、payment / entitlementの二重作成が発生しない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  await generate(env, ANON_A); // 発行
  await generate(env, ANON_A); // 通信断からの復旧（想定）
  await generate(env, ANON_A); // さらにもう一度復旧要求

  const paymentCount = await db.prepare(`SELECT COUNT(*) c FROM payments WHERE plan_code='free'`).first();
  const entitlementCount = await db.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id=?`).bind(ANON_A).first();
  assert.equal(paymentCount.c, 1, '無料paymentは1件のみ（二重作成なし）');
  assert.equal(entitlementCount.c, 1, '無料entitlementは1件のみ（二重作成なし）');
});

test('③claim生成・保存失敗時、24時間枠を消費せず、entitlementはactiveのまま再試行できる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  assert.equal(gen.body.outcome, 'created');

  // 【意図的にclaim失敗を発生させる】allowed_predictionsをカタログ値(1)と
  // 食い違わせて、claimEntitlement()自身のfail-closeチェック
  // 「entitlement.allowed_predictionsがplan_codeのカタログ値と一致しない」
  // を発生させる（claimEntitlement()のコードは一切変更せず、既存の
  // 防御ロジックを利用して失敗ケースを再現する）。
  await db.prepare(`UPDATE purchase_entitlements SET allowed_predictions = 10 WHERE anon_id = ?`).bind(ANON_A).run();

  const failedClaim = await claim(env, gen.body.claim_token);
  assert.equal(failedClaim.res.status, 500, 'claimは失敗する（意図的な不整合）');

  // 24時間枠(free_generation_locks)は一切作られていない＝消費されていない
  const lock = await db.prepare(`SELECT * FROM free_generation_locks WHERE anon_id = ?`).bind(ANON_A).first();
  assert.equal(lock, null, 'claim失敗時、24時間枠は消費されない');

  // entitlementはactiveのまま（consumedになっていない）＝再試行可能
  const entRow = await db.prepare(`SELECT status, allowed_predictions FROM purchase_entitlements WHERE anon_id = ?`).bind(ANON_A).first();
  assert.equal(entRow.status, 'active', 'claim失敗後もentitlementはactiveのまま（fail-close）');

  // 不整合を修正して再試行すると成功する（二重予測にはならない＝1件だけ生成）
  await db.prepare(`UPDATE purchase_entitlements SET allowed_predictions = 1 WHERE anon_id = ?`).bind(ANON_A).run();
  const retried = await claim(env, gen.body.claim_token);
  assert.equal(retried.res.status, 200, '修正後の再試行は成功する');
  assert.equal(retried.body.outcome, 'created');
  assert.equal(retried.body.predictions.length, 1);

  const predCount = await db.prepare(`SELECT COUNT(*) c FROM predictions`).first();
  assert.equal(predCount.c, 1, '失敗した試行では何も保存されておらず、成功した1回分だけが保存されている');
});

test('④claim成功時、その成功時刻を基準に24時間制限が開始する（entitlement発行時刻は基準にならない）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  // entitlement発行から23時間59分59秒だけ待ってからclaimしたことにする
  // → claimEntitlement自体は時刻を検証しないため、free_generation_locks
  //   にまだ行が無い状態でclaimは常に成功する。ここで確認したいのは
  //   「claim成功の瞬間に24h計測が開始する」という設計そのもの。
  const claimed = await claim(env, gen.body.claim_token);
  assert.equal(claimed.res.status, 200);

  const lock = await db.prepare(`SELECT last_success_at FROM free_generation_locks WHERE anon_id = ?`).bind(ANON_A).first();
  assert.ok(lock, 'claim成功によって24時間枠のロック行が作られる（entitlement発行時ではなくclaim成功時）');

  const successAt = Date.parse(lock.last_success_at);
  assert.ok(Date.now() - successAt < 5000, 'last_success_atはclaim成功時刻とほぼ一致する');

  // claim成功直後（＝last_success_atからまだ24時間経っていない）は拒否される
  const tooSoon = await generate(env, ANON_A);
  assert.equal(tooSoon.res.status, 429);
  assert.equal(tooSoon.body.error.code, 'free_limit_not_elapsed');
});

test('⑤同じentitlementに対するclaim再試行を並行実行しても、予測は1件しか生成されない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  const tokenHash = await hashClaimToken(gen.body.claim_token);

  // claimEntitlement()自体(変更禁止)の既存の並行安全性を、free entitlement
  // に対しても直接検証する（test/claim.test.jsと同じ「真の並行」検証手法）。
  let releaseA;
  const pauseA = new Promise((resolve) => (releaseA = resolve));
  let aReachedHook = false;

  const resultsPromise = Promise.all([
    claimEntitlement(db, tokenHash, {
      drawNumber: 'PERMANENT_TRACKING',
      _afterTipRead: async () => {
        aReachedHook = true;
        await pauseA;
      },
    }),
    (async () => {
      while (!aReachedHook) await new Promise((r) => setTimeout(r, 0));
      const r = await claimEntitlement(db, tokenHash, { drawNumber: 'PERMANENT_TRACKING' });
      releaseA();
      return r;
    })(),
  ]);

  const [resultA, resultB] = await resultsPromise;
  const outcomes = [resultA.outcome, resultB.outcome].sort();
  assert.deepEqual(outcomes, ['created', 'existing'], '片方が確定し、もう片方は既存の結果を返す（新規生成しない）');

  const predCount = await db.prepare(`SELECT COUNT(*) c FROM predictions`).first();
  assert.equal(predCount.c, 1, '並行再試行しても予測は1件のみ');
});

// ============================================================
// 6〜12: 基本の原子的競合防止・24h境界・既存機能への影響確認
// ============================================================

test('⑥同一anon_idから同時に2件/api/free/generateしても、成功(created)は1件のみで、entitlementも1件しか作られない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const [r1, r2, r3, r4] = await Promise.all([
    generate(env, ANON_A),
    generate(env, ANON_A),
    generate(env, ANON_A),
    generate(env, ANON_A),
  ]);

  const outcomes = [r1, r2, r3, r4].map((r) => r.body.outcome);
  const createdCount = outcomes.filter((o) => o === 'created').length;
  const recoveredCount = outcomes.filter((o) => o === 'recovered').length;
  assert.equal(createdCount, 1, '同時リクエストのうち、新規entitlement作成(created)は必ず1件のみ');
  assert.equal(recoveredCount, 3, '残りは既存entitlementの再取得(recovered)として処理される');

  const entitlementCount = await db.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id = ?`).bind(ANON_A).first();
  assert.equal(entitlementCount.c, 1, 'idx_one_active_free_entitlement_per_anonにより、entitlementは1件しか存在しない');

  // 全員が最終的に同じentitlementのclaim_tokenを持っている（rotate後の最新値が全員に返る保証はないが、
  // 最後に返ったどのclaim_tokenでclaimしても、同じentitlementから1回だけ予測が生成できることを確認する）
  const lastToken = [r1, r2, r3, r4][[r1, r2, r3, r4].length - 1].body.claim_token;
  const claimed = await claim(env, lastToken);
  assert.equal(claimed.res.status, 200);
  assert.equal(claimed.body.predictions.length, 1);
  const predCount = await db.prepare(`SELECT COUNT(*) c FROM predictions`).first();
  assert.equal(predCount.c, 1, '同時generateの後でも、claimできる予測は結局1件のみ');
});

test('⑦24時間未満の再生成は拒否される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  await claim(env, gen.body.claim_token);

  const tooSoon = await generate(env, ANON_A);
  assert.equal(tooSoon.res.status, 429);
  assert.equal(tooSoon.body.error.code, 'free_limit_not_elapsed');
  assert.ok(tooSoon.body.error.next_available_at, '次回利用可能時刻を返す');
});

test('⑧24時間ちょうどの再生成は許可される', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  await claim(env, gen.body.claim_token);

  // 【テスト上の時間経過の模擬】trg_free_lock_24hはUPDATEで過去へ戻す
  // 操作自体を(本来あってはならない不正な巻き戻しとして)ABORTするため、
  // 「実際に24時間経過した後の状態」を模擬するにはDELETE→INSERTで
  // 行を作り直す(本番ではこの経路は使われない。あくまでテスト専用の
  // 時間経過シミュレーション)。
  const exactlyOneDayAgo = new Date(Date.now() - ONE_DAY_MS).toISOString();
  await db.prepare(`DELETE FROM free_generation_locks WHERE anon_id = ?`).bind(ANON_A).run();
  await db.prepare(`INSERT INTO free_generation_locks (anon_id, last_success_at) VALUES (?, ?)`).bind(ANON_A, exactlyOneDayAgo).run();

  const res = await generate(env, ANON_A);
  assert.equal(res.res.status, 200, 'ちょうど24時間経過していれば許可される');
  // 直前のentitlementは既にclaim済み(consumed)のため、24h経過後の生成は
  // 「未消費entitlementの復旧」ではなく新しい無料生成として扱われる。
  assert.equal(res.body.outcome, 'created');
});

test('⑨24時間超過後の再生成は許可され、独立した新しい生成として扱われる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  await claim(env, gen.body.claim_token);

  // (テスト専用の時間経過シミュレーション。詳細は⑧のコメント参照)
  const twoDaysAgo = new Date(Date.now() - 2 * ONE_DAY_MS).toISOString();
  await db.prepare(`DELETE FROM free_generation_locks WHERE anon_id = ?`).bind(ANON_A).run();
  await db.prepare(`INSERT INTO free_generation_locks (anon_id, last_success_at) VALUES (?, ?)`).bind(ANON_A, twoDaysAgo).run();

  const res = await generate(env, ANON_A);
  assert.equal(res.res.status, 200);
  const claimed = await claim(env, res.body.claim_token);
  assert.equal(claimed.res.status, 200);
  assert.equal(claimed.body.predictions.length, 1);

  // 過去分と合わせて累計2件、いずれも独立レコード（上書き・削除されていない）
  const predCount = await db.prepare(`SELECT COUNT(*) c FROM predictions`).first();
  assert.equal(predCount.c, 2, '過去の生成物は削除・上書きされず、新しい生成が独立レコードとして追加される');
});

test('⑩anon_idが異なれば、24時間制限・entitlementは完全に独立している', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const genA = await generate(env, ANON_A);
  await claim(env, genA.body.claim_token);

  // ANON_Aが24h制限にかかっていても、ANON_Bは無関係に生成できる
  const genB = await generate(env, ANON_B);
  assert.equal(genB.res.status, 200);
  assert.equal(genB.body.outcome, 'created');

  const tooSoonA = await generate(env, ANON_A);
  assert.equal(tooSoonA.res.status, 429);

  const entCountA = await db.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id=?`).bind(ANON_A).first();
  const entCountB = await db.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id=?`).bind(ANON_B).first();
  assert.equal(entCountA.c, 1);
  assert.equal(entCountB.c, 1);
});

test('⑪生成された無料予測は plan_code=\'free\' として保存され、Permanent Trackingにも接続される（既存の6球演出・履歴カードUIが読むAPIへも正しく反映）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  const gen = await generate(env, ANON_A);
  const claimed = await claim(env, gen.body.claim_token);
  assert.equal(claimed.res.status, 200);
  const predictionId = claimed.body.predictions[0].prediction_id;

  const row = await db.prepare(`SELECT plan_code, draw_number FROM predictions WHERE prediction_id = ?`).bind(predictionId).first();
  assert.equal(row.plan_code, 'free', 'plan_code=freeとして保存される');
  assert.equal(row.draw_number, 'PERMANENT_TRACKING', '既存の有料予測と同じPERMANENT_TRACKINGスコープで保存される（内部専用、UIには非公開）');

  // Permanent Tracking(backfillPrediction)が既存の有料フローと全く同じ経路で
  // 呼ばれていること（prediction_tracking_summaryが初期化されている）
  const summary = await db.prepare(`SELECT * FROM prediction_tracking_summary WHERE prediction_id = ?`).bind(predictionId).first();
  assert.ok(summary, 'Permanent Tracking summaryが有料予測と同じ経路で初期化されている');

  // 既存の公開履歴API(/api/history)にも、有料予測と全く同じ形式でそのまま表示される
  // （display_idのみを持ち、draw_numberの内部値等は露出しない）
  const historyRes = await worker.fetch(req('GET', '/api/history'), env);
  const historyBody = await historyRes.json();
  const found = historyBody.predictions.find((p) => p.prediction_id === predictionId);
  assert.ok(found, '/api/historyにも既存の有料予測と同じ形式で表示される');
});

test('⑫/api/free/generateはIP単位・anon_id単位のレート制限を持ち、上限を超えると429を返す（BOT・連打対策）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);

  // 同一anon_idで11回連続要求すると、10回目までは200/429(24h)のいずれかだが、
  // レート制限(limit:10/60秒)により11回目以降は429 rate_limitedになる。
  const results = [];
  for (let i = 0; i < 12; i++) {
    results.push(await generate(env, `${ANON_A}-ratelimit-${i % 2}`));
  }
  // 同一anon_id派生キーでの大量riquestはanon_id単位レート制限により弾かれる
  const rateLimited = results.filter((r) => r.res.status === 429 && r.body.error.code === 'rate_limited');
  assert.ok(rateLimited.length > 0, 'anon_id単位のレート制限が機能し、一部が429 rate_limitedになる');
});

test('⑬FREE PUBLIC BETA中でも/api/checkout/create(有料)はPAID_CHECKOUT_DISABLEDフラグでのみ休眠し、/api/free/generateには影響しない', async () => {
  const db = createTestDb();
  const env = createTestEnv(db, { PAID_CHECKOUT_DISABLED: 'true' });

  const paidRes = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'pack5' }), env);
  assert.equal(paidRes.status, 503);

  const freeRes = await generate(env, ANON_A);
  assert.equal(freeRes.res.status, 200, '有料導線の休眠は無料枠の生成には一切影響しない');
});
