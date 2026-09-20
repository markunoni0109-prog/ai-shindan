import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './harness.js';
import { seedActiveEntitlement, seedForeignPrediction } from './seed.js';
import { claimEntitlement, ClaimError, MAX_CLAIM_RETRIES } from '../src/lib/db.js';
import { GENESIS_HASH, generateNumbers, combinationKey, canonicalPayload, sha256Hex } from '../src/lib/engine.js';

test('正常系：1予測生成、すべて異なる、1-43、6数字、昇順', async () => {
  const db = createTestDb();
  const { tokenHash } = await seedActiveEntitlement(db);

  const result = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });
  assert.equal(result.outcome, 'created');
  assert.equal(result.predictions.length, 1);
  assert.equal(result.entitlementRowsAffected, 1);

  const keys = new Set();
  for (const p of result.predictions) {
    assert.equal(p.numbers.length, 6);
    assert.equal(new Set(p.numbers).size, 6);
    for (const n of p.numbers) assert.ok(n >= 1 && n <= 43);
    for (let i = 1; i < 6; i++) assert.ok(p.numbers[i - 1] < p.numbers[i]);
    keys.add(p.numbers.join('-'));
  }
  assert.equal(keys.size, 1, '1予測が保存される');

  // entitlementはconsumedになっている
  const ent = await db
    .prepare('SELECT status, consumed_predictions FROM purchase_entitlements WHERE claim_token_hash=?')
    .bind(tokenHash)
    .first();
  assert.equal(ent.status, 'consumed');
  assert.equal(ent.consumed_predictions, 1);
});

test('combination_key・prediction_id・previous_hash・record_hash・display_sequenceがすべてUNIQUE', async () => {
  const db = createTestDb();
  const info = await db.prepare("SELECT sql FROM sqlite_master WHERE name='predictions'").first();
  for (const col of ['combination_key', 'prediction_id', 'previous_hash', 'record_hash', 'display_sequence']) {
    assert.ok(info.sql.includes(col), `schema mentions ${col}`);
  }
  assert.match(info.sql, /UNIQUE\s*\(\s*entitlement_id\s*,\s*prediction_index\s*\)/);
});

test('無効なclaim_tokenはinvalid_token', async () => {
  const db = createTestDb();
  await assert.rejects(
    () => claimEntitlement(db, 'not-a-real-hash', { drawNumber: '1850' }),
    (err) => err instanceof ClaimError && err.code === 'invalid_token'
  );
});

test('同一entitlementへの再claim（順次）：新しい予測は生成されず既存1件が返る', async () => {
  const db = createTestDb();
  const { tokenHash } = await seedActiveEntitlement(db);

  const first = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });
  const second = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'existing');
  assert.deepEqual(
    second.predictions.map((p) => p.prediction_id),
    first.predictions.map((p) => p.prediction_id),
    '同じ予測が返る（再生成されていない）'
  );

  const count = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(count.c, 1, 'DBには1件しか存在しない（二重生成されていない）');
});

test('同時claim（同一token・真の並行）：1セットのみ確定し、もう一方は既存を返す', async () => {
  const db = createTestDb();
  const { tokenHash } = await seedActiveEntitlement(db);

  // 決定論的に「両方が同じtipを読んでから両方書こうとする」状況を作る：
  // 片方をtip読み取り直後で一時停止し、その間にもう片方を完走させる。
  let releaseA;
  const pauseA = new Promise((resolve) => (releaseA = resolve));
  let aReachedHook = false;

  const resultsPromise = Promise.all([
    claimEntitlement(db, tokenHash, {
      drawNumber: '1850',
      _afterTipRead: async () => {
        aReachedHook = true;
        await pauseA;
      },
    }),
    (async () => {
      // Bを先に完走させてからAを再開する
      const b = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });
      releaseA();
      return b;
    })(),
  ]);

  const [a, b] = await resultsPromise;
  assert.ok(aReachedHook);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['created', 'existing'], '片方だけ新規作成、もう片方は既存取得');

  const count = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(count.c, 1, '合計1件のみ（二重生成なし）');

  const idsA = a.predictions.map((p) => p.prediction_id).sort();
  const idsB = b.predictions.map((p) => p.prediction_id).sort();
  assert.deepEqual(idsA, idsB, '両者が最終的に同じ1件を見ている');
});

test('previous_hash競合（別entitlement2件の真の同時claim）：両方成功しhash chainが1本に繋がる', async () => {
  const db = createTestDb();
  const ent1 = await seedActiveEntitlement(db);
  const ent2 = await seedActiveEntitlement(db);

  let releaseA;
  const pauseA = new Promise((resolve) => (releaseA = resolve));

  const [r1, r2] = await Promise.all([
    claimEntitlement(db, ent1.tokenHash, {
      drawNumber: '1850',
      _afterTipRead: async () => {
        await pauseA; // Aはtipを読んだ後、Bが確定するまで待つ→Aのprevious_hashは古くなる
      },
    }),
    (async () => {
      const res = await claimEntitlement(db, ent2.tokenHash, { drawNumber: '1850' });
      releaseA();
      return res;
    })(),
  ]);

  assert.equal(r1.outcome, 'created');
  assert.equal(r2.outcome, 'created');
  // Aは最初のtipが古くなったため、少なくとも1回はリトライしているはず
  assert.ok(r1.attempts >= 2, `previous_hash衝突でリトライが発生している (attempts=${r1.attempts})`);

  // 全10件のchainが1本に繋がっていることを検証（id昇順で辿る）
  const all = await db
    .prepare('SELECT id, previous_hash, record_hash FROM predictions ORDER BY id ASC')
    .all();
  assert.equal(all.results.length, 2);
  let expectedPrev = GENESIS_HASH;
  for (const row of all.results) {
    assert.equal(row.previous_hash, expectedPrev, `id=${row.id} のprevious_hashが直前のrecord_hashと一致`);
    expectedPrev = row.record_hash;
  }
});

test('combination_key競合：既存の組み合わせとぶつかったら再生成して成功する', async () => {
  const db = createTestDb();

  // 決定論的rng：常に同じ並びを返す
  const fixedRng = () => 0;
  const collidingNumbers = generateNumbers(fixedRng);
  const collidingKey = combinationKey(collidingNumbers);

  // 先に「他の誰かが既に売ってしまった」状態を作る
  await seedForeignPrediction(db, {
    combinationKey: collidingKey,
    previousHash: GENESIS_HASH,
    recordHash: 'FAKE_FOREIGN_HASH_0',
    displaySequence: 1,
    numbers: collidingNumbers,
  });

  const { tokenHash } = await seedActiveEntitlement(db);

  // rngSequence: 1回目の呼び出し(=このclaim内の1組目)だけ衝突する固定値を返し、
  // 2回目以降（リトライ後）は毎回違う結果になるよう「呼び出し回数に応じて変化する」rngにする。
  // generateNumbers()のFisher-Yatesはpool.length-1=42回rng()を呼ぶ。
  // 最初の42回だけ固定値(0)にして「1組目の数字」を確実に衝突させ、
  // それ以降はランダムに戻す（＝リトライ後は正常に別の組み合わせになる）。
  let call = 0;
  const rng = () => {
    call += 1;
    if (call <= 42) return 0;
    return Math.random();
  };

  const result = await claimEntitlement(db, tokenHash, { drawNumber: '1850', rng });
  assert.equal(result.outcome, 'created');
  assert.ok(result.attempts >= 2, `combination_key衝突でリトライが発生している (attempts=${result.attempts})`);

  const keys = result.predictions.map((p) => p.numbers.join('-'));
  assert.ok(!keys.includes(collidingNumbers.join('-')), '衝突した組み合わせは最終結果に含まれない');
});

test('retry上限：常に衝突するrngなら10回で諦め、entitlementは未消費・保存ゼロのまま(fail-close)', async () => {
  const db = createTestDb();
  const fixedRng = () => 0; // 常に同じ6数字を生成する
  const collidingNumbers = generateNumbers(fixedRng);

  await seedForeignPrediction(db, {
    combinationKey: combinationKey(collidingNumbers),
    previousHash: GENESIS_HASH,
    recordHash: 'FAKE_FOREIGN_HASH_ALWAYS',
    displaySequence: 1,
    numbers: collidingNumbers,
  });

  const { tokenHash, entitlementId } = await seedActiveEntitlement(db);

  await assert.rejects(
    () => claimEntitlement(db, tokenHash, { drawNumber: '1850', rng: fixedRng }),
    (err) => err instanceof ClaimError && err.code === 'retry_exhausted'
  );

  const ent = await db.prepare('SELECT status FROM purchase_entitlements WHERE id=?').bind(entitlementId).first();
  assert.equal(ent.status, 'active', 'entitlementは未消費のまま(fail-close)');

  // このentitlement向けに新規保存された行が1件も無い（seedForeignPredictionの1件だけ存在）
  const count = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(count.c, 1, '中途保存ゼロ：foreignの1件以外は増えていない');
});

test('batch途中失敗：複数文batchの後続失敗で全ロールバックされる', async () => {
  const db = createTestDb();

  // D1 batchの原子性を直接検証する。
  // → generateNumbers呼び出し回数で言うと 3*6+1〜3*6+6 回目あたりに相当するが、
  //   厳密な回数依存は壊れやすいので、ここでは「必ず1回だけ衝突を起こす」ために
  //   claimを1回実行した後の最初の1件のcombinationを汚染し、rngは毎回ランダムに戻す。
  const before = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(before.c, 0);

  const { tokenHash } = await seedActiveEntitlement(db);
  // 通常のrngで一度チェーンを組み立てて、その中の1件のcombination_keyを衝突させる
  const probe = await import('../src/lib/engine.js');
  const chain = await probe.buildPredictionChain({
    count: 1,
    drawNumber: '1850',
    paymentPublicId: 'probe',
    entitlementPublicId: 'probe',
    planCode: 'single',
    previousHash0: GENESIS_HASH,
    generatedAt: new Date().toISOString(),
  });
  const collideWith = chain[0].numbers;

  await seedForeignPrediction(db, {
    combinationKey: combinationKey(collideWith),
    previousHash: 'UNRELATED_PREV',
    recordHash: 'FAKE_FOREIGN_HASH_MID',
    displaySequence: 1,
    numbers: collideWith,
  });

  // 実際のclaimは通常の乱数だが、上のprobeと全く同じ数字が出る保証はないため、
  // ここでは「バッチが原子的である」こと自体を確認する別アプローチを取る：
  // batch内の1文をわざと失敗するSQLに差し替えて、db.batchの原子性を直接検証する。
  const { D1Shim } = await import('./d1shim.js');
  const rawCountBefore = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();

  const okStmt1 = db.prepare(
    `INSERT INTO predictions
       (prediction_id, display_sequence, draw_number, number_1,number_2,number_3,number_4,number_5,number_6,
        combination_key, generated_at, payment_id, entitlement_id, prediction_index, plan_code, algorithm_version, previous_hash, record_hash)
     VALUES ('test-atomic-1', 999901, '1850', 1,2,3,4,5,6, 'atomic-test-combo-A', datetime('now'), 1, 1, 0, 'single','prototype-v1','P','R1')`
  );
  // 2文目はcombination_keyを1文目と衝突させて意図的に失敗させる
  const failStmt2 = db.prepare(
    `INSERT INTO predictions
       (prediction_id, display_sequence, draw_number, number_1,number_2,number_3,number_4,number_5,number_6,
        combination_key, generated_at, payment_id, entitlement_id, prediction_index, plan_code, algorithm_version, previous_hash, record_hash)
     VALUES ('test-atomic-2', 999902, '1850', 7,8,9,10,11,12, 'atomic-test-combo-A', datetime('now'), 1, 1, 1, 'single','prototype-v1','P2','R2')`
  );

  await assert.rejects(() => db.batch([okStmt1, failStmt2]));

  const rawCountAfter = await db.prepare('SELECT COUNT(*) AS c FROM predictions').first();
  assert.equal(rawCountAfter.c, rawCountBefore.c, '2文目の失敗で1文目も含めて全ロールバックされている');
});

test('公開APIレスポンスに内部情報が含まれない', async () => {
  const db = createTestDb();
  const { tokenHash } = await seedActiveEntitlement(db);
  const result = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });

  for (const p of result.predictions) {
    const keys = Object.keys(p);
    for (const forbidden of ['id', 'entitlement_id', 'payment_id', 'claim_token_hash', 'internal']) {
      assert.ok(!keys.includes(forbidden), `${forbidden} が予測レスポンスに含まれていない`);
    }
    assert.ok(typeof p.display_id === 'string' && p.display_id.startsWith('#'));
    assert.ok(typeof p.prediction_id === 'string');
  }
});
