import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from './d1shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * 【migration 0007 本番適用前の慎重な監査】
 *
 * migration 0007は payments / purchase_intents / purchase_entitlements /
 * predictions と、predictionsを参照する4テーブルを
 * 「RENAME→CREATE→INSERT SELECT→DROP」で再構築し（0005と同じ手順、
 * 対象がpurchase_intentsまで広がった点のみ異なる）、加えて
 *   - purchase_entitlements.anon_id 列の追加
 *   - idx_one_active_free_entitlement_per_anon（部分UNIQUEインデックス）
 *   - free_generation_locks テーブルと24hトリガー(trg_free_lock_24h)
 *   - free_generation_log テーブル
 * を新設する。ここでは「migration 0007適用前に、まとめ買い機能まで
 * 完成した状態(0001-0006)で実際に有料運用していたのと同等のデータ」を
 * 用意し、0007適用の前後でmigration_0005_audit.test.jsと同じ観点
 * （件数不変・id/hashチェーン不変・immutabilityトリガー健在・
 * 壊れたFK参照が残らない）に加えて、新設した無料枠関連の制約が
 * 設計どおりに機能することを実データで確認する。
 */

function applyMigrations(rawDb, fileNames) {
  const migrationsDir = path.join(ROOT, 'migrations');
  for (const file of fileNames) {
    rawDb.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
}

const PRE_0007_MIGRATIONS = [
  '0001_init.sql',
  '0002_predictions_immutability_triggers.sql',
  '0003_stripe_and_ratelimit.sql',
  '0004_permanent_tracking.sql',
  '0005_bulk_purchase_plans.sql',
  '0006_purchase_recovery.sql',
];

function seedPaidData(db) {
  // 0005/0006適用後の実運用相当データ（まとめ買い含む）を3件分用意する。
  db.exec(`
    INSERT INTO payments(payment_public_id,stripe_checkout_session_id,stripe_payment_intent_id,plan_code,amount,currency,payment_status,paid_at,stripe_event_id,customer_email_hash)
    VALUES
      ('pay_pub_1','cs_1','pi_1','single',300,'jpy','paid','2026-01-01T00:00:00Z','evt_1','em_hash_1'),
      ('pay_pub_2','cs_2','pi_2','pack10',2500,'jpy','paid','2026-01-02T00:00:00Z','evt_2',NULL),
      ('pay_pub_3','cs_3','pi_3','single',300,'jpy','paid','2026-01-03T00:00:00Z','evt_3',NULL);

    INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id,fulfilled_at,stripe_checkout_session_id)
    VALUES
      ('int_1','single','th_1','fulfilled',1,'2026-01-01T00:00:01Z','cs_1'),
      ('int_2','pack10','th_2','fulfilled',2,'2026-01-02T00:00:01Z','cs_2'),
      ('int_3','single','th_3','fulfilled',3,'2026-01-03T00:00:01Z','cs_3');

    INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,consumed_predictions,status,claim_token_hash,consumed_at)
    VALUES
      ('ent_1',1,1,1,1,'consumed','cth_1','2026-01-01T00:00:02Z'),
      ('ent_2',2,2,10,10,'consumed','cth_2','2026-01-02T00:00:02Z'),
      ('ent_3',3,3,1,1,'consumed','cth_3','2026-01-03T00:00:02Z');

    INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash)
    VALUES
      ('pred_1',1,'PERMANENT_TRACKING',1,2,3,4,5,6,'01-02-03-04-05-06','2026-01-01T00:00:02Z',1,1,1,'single','v1','GENESIS','hash_1'),
      ('pred_2',2,'PERMANENT_TRACKING',7,8,9,10,11,12,'07-08-09-10-11-12','2026-01-02T00:00:02Z',2,2,1,'pack10','v1','hash_1','hash_2'),
      ('pred_3',3,'PERMANENT_TRACKING',13,14,15,16,17,18,'13-14-15-16-17-18','2026-01-03T00:00:02Z',3,3,1,'single','v1','hash_2','hash_3');

    INSERT INTO lottery_draws(draw_id,draw_number,draw_date,n1,n2,n3,n4,n5,n6,bonus_number,source)
    VALUES ('draw_legacy_1',1999,'2026-01-05',1,2,3,20,21,22,30,'official-test');

    INSERT INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws,checked_at)
    VALUES ('pred_1','draw_legacy_1','forward_tracking',3,0,'5',4,1,'2026-01-05T00:00:00Z');

    INSERT INTO prediction_tracking_summary(prediction_id,checked_draw_count,best_main_match_count,best_bonus_match,best_equivalent_rank,best_draw_id,days_to_best,draws_to_best,first_3plus_draw_id,updated_at)
    VALUES ('pred_1',1,3,0,'5','draw_legacy_1',4,1,'draw_legacy_1','2026-01-05T00:00:00Z');

    INSERT INTO prediction_generation_features(prediction_id,features_json,captured_at)
    VALUES ('pred_1','{"sum":21}','2026-01-01T00:00:02Z'), ('pred_2','{"sum":57}','2026-01-02T00:00:02Z'), ('pred_3','{"sum":93}','2026-01-03T00:00:02Z');

    INSERT INTO prediction_results(prediction_id,winning_number_1,winning_number_2,winning_number_3,winning_number_4,winning_number_5,winning_number_6,bonus_number,matched_numbers,match_count,prize_rank,result_source,verified_at)
    VALUES ('pred_1',1,2,3,20,21,22,30,'1,2,3',3,'5等','official-test','2026-01-05T00:00:00Z');

    INSERT INTO recovery_requests(recovery_token_hash,customer_email_hash,expires_at)
    VALUES ('rt_hash_1','em_hash_1','2026-01-02T00:00:00Z');
  `);
}

function tableCounts(rawDb, tables) {
  const out = {};
  for (const t of tables) out[t] = rawDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return out;
}

const ALL_TABLES = [
  'payments', 'purchase_intents', 'purchase_entitlements', 'predictions',
  'lottery_draws', 'prediction_matches', 'prediction_tracking_summary',
  'prediction_generation_features', 'prediction_results', 'recovery_requests',
];

test('migration 0007: 適用前後で全テーブルの件数が一切変わらない（既存データを失わない）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);

  const before = tableCounts(rawDb, ALL_TABLES);
  assert.deepEqual(before, {
    payments: 3, purchase_intents: 3, purchase_entitlements: 3, predictions: 3,
    lottery_draws: 1, prediction_matches: 1, prediction_tracking_summary: 1,
    prediction_generation_features: 3, prediction_results: 1, recovery_requests: 1,
  });

  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  const after = tableCounts(rawDb, ALL_TABLES);
  assert.deepEqual(after, before, 'migration 0007適用後も全テーブルの件数が完全に一致する');
});

test('migration 0007: idとrecord_hashチェーンの値・FKで辿れる関係が一切変更されない', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);

  const chainBefore = rawDb.prepare('SELECT id, prediction_id, previous_hash, record_hash, payment_id, entitlement_id FROM predictions ORDER BY id').all();
  const paymentIdsBefore = rawDb.prepare('SELECT id, payment_public_id FROM payments ORDER BY id').all();
  const intentIdsBefore = rawDb.prepare('SELECT id, intent_public_id, payment_id FROM purchase_intents ORDER BY id').all();

  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  const chainAfter = rawDb.prepare('SELECT id, prediction_id, previous_hash, record_hash, payment_id, entitlement_id FROM predictions ORDER BY id').all();
  const paymentIdsAfter = rawDb.prepare('SELECT id, payment_public_id FROM payments ORDER BY id').all();
  const intentIdsAfter = rawDb.prepare('SELECT id, intent_public_id, payment_id FROM purchase_intents ORDER BY id').all();

  assert.deepEqual(chainAfter, chainBefore, 'record_hashチェーン(previous_hash/record_hash)とid・FKは完全に不変');
  assert.deepEqual(paymentIdsAfter, paymentIdsBefore, 'paymentsのidも保持される');
  assert.deepEqual(intentIdsAfter, intentIdsBefore, 'purchase_intentsのidとpayment_idも保持される');

  // FKで実際に辿れることを確認（predictions→payments/purchase_entitlements、
  // purchase_entitlements→purchase_intents→payments の多段JOINが機能する）
  const joined = rawDb
    .prepare(
      `SELECT pr.prediction_id, pay.payment_public_id, e.entitlement_public_id, pi.intent_public_id
       FROM predictions pr
       JOIN payments pay ON pay.id = pr.payment_id
       JOIN purchase_entitlements e ON e.id = pr.entitlement_id
       JOIN purchase_intents pi ON pi.id = e.purchase_intent_id
       ORDER BY pr.id`
    )
    .all();
  assert.equal(joined.length, 3, '再構築後もpredictions→payments/purchase_entitlements→purchase_intentsのJOINが機能する');
});

test('migration 0007: predictions/prediction_matches/lottery_drawsのUPDATE/DELETE拒否トリガーが再構築後も機能する', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  assert.throws(() => rawDb.exec(`UPDATE predictions SET number_1 = 99 WHERE prediction_id='pred_1'`), /immutable/);
  assert.throws(() => rawDb.exec(`DELETE FROM predictions WHERE prediction_id='pred_1'`), /immutable/);
  assert.throws(() => rawDb.exec(`UPDATE prediction_matches SET main_match_count = 0`), /immutable/);
  assert.throws(() => rawDb.exec(`DELETE FROM prediction_matches`), /immutable/);
  assert.throws(() => rawDb.exec(`UPDATE lottery_draws SET n1 = 99 WHERE draw_id='draw_legacy_1'`), /immutable/);
});

test('migration 0007: payments/purchase_intents/purchase_entitlements/predictionsを参照するテーブルに"_old_0007"を指す壊れたFK参照が一切残らない', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  const dangling = rawDb.prepare(`SELECT name, sql FROM sqlite_master WHERE sql LIKE '%old_0007%'`).all();
  assert.equal(dangling.length, 0, `old_0007を参照するスキーマオブジェクトが残っていない: ${JSON.stringify(dangling)}`);

  // 新規INSERTでFKが実際に機能することも確認
  assert.throws(
    () => rawDb.exec(`INSERT INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,elapsed_days,elapsed_draws,checked_at) VALUES('does_not_exist','draw_legacy_1','historical_backtest',0,0,NULL,NULL,'2026-01-01T00:00:00Z')`),
    /FOREIGN KEY/,
    '存在しないprediction_idへのINSERTはFK制約で弾かれる（predictionsを正しく参照している証拠）'
  );
  assert.throws(
    () => rawDb.exec(`INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id) VALUES('int_bad','single','th_bad','pending',9999)`),
    /FOREIGN KEY/,
    '存在しないpayments.idへのpurchase_intents INSERTはFK制約で弾かれる（payments_old_0007ではなくpaymentsを正しく参照している証拠）'
  );
});

test('migration 0007: payments/predictions で plan_code=\'free\' が新たに許容される（既存プランのCHECKは維持）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  // 'free' は許容される
  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_free_1','free',0,'jpy','paid')`);
  const row = rawDb.prepare(`SELECT plan_code FROM payments WHERE payment_public_id='pay_free_1'`).get();
  assert.equal(row.plan_code, 'free');

  // 未知の値は引き続き拒否される
  assert.throws(
    () => rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_bad','bogus',0,'jpy','paid')`),
    /CHECK constraint failed/
  );
});

test('migration 0007: purchase_entitlements で同一anon_idのactive行は同時に1つまで（部分UNIQUEインデックス）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_free_a','free',0,'jpy','paid')`);
  rawDb.exec(
    `INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash,anon_id) VALUES('ent_free_a',(SELECT id FROM payments WHERE payment_public_id='pay_free_a'),1,'active','cth_free_a','anon-x')`
  );

  // 同一anon_id='anon-x'でもう1件activeを作ろうとすると部分UNIQUEインデックスで拒否される
  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_free_b','free',0,'jpy','paid')`);
  assert.throws(
    () =>
      rawDb.exec(
        `INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash,anon_id) VALUES('ent_free_b',(SELECT id FROM payments WHERE payment_public_id='pay_free_b'),1,'active','cth_free_b','anon-x')`
      ),
    /UNIQUE constraint failed/
  );

  // 既存行がconsumedになれば、同じanon_idで新たなactive行を作れる
  rawDb.exec(`UPDATE purchase_entitlements SET status='consumed', consumed_at='2026-01-10T00:00:00Z' WHERE entitlement_public_id='ent_free_a'`);
  rawDb.exec(
    `INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash,anon_id) VALUES('ent_free_c',(SELECT id FROM payments WHERE payment_public_id='pay_free_b'),1,'active','cth_free_c','anon-x')`
  );
  const activeCount = rawDb.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id='anon-x' AND status='active'`).get().c;
  assert.equal(activeCount, 1, 'consumed後は新たなactive行を1件だけ作れる');

  // 別のanon_idは独立して同時にactiveを持てる（anon間で競合しない）
  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_free_d','free',0,'jpy','paid')`);
  rawDb.exec(
    `INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash,anon_id) VALUES('ent_free_d',(SELECT id FROM payments WHERE payment_public_id='pay_free_d'),1,'active','cth_free_d','anon-y')`
  );
  const otherAnonActive = rawDb.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id='anon-y' AND status='active'`).get().c;
  assert.equal(otherAnonActive, 1);

  // 有料entitlement（anon_id IS NULL）は部分インデックスの対象外＝複数active可
  const paidActiveBefore = rawDb.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id IS NULL AND status='active'`).get().c;
  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay_paid_extra','single',300,'jpy','paid')`);
  rawDb.exec(
    `INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash) VALUES('ent_paid_extra',(SELECT id FROM payments WHERE payment_public_id='pay_paid_extra'),1,'active','cth_paid_extra')`
  );
  const paidActiveAfter = rawDb.prepare(`SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id IS NULL AND status='active'`).get().c;
  assert.equal(paidActiveAfter, paidActiveBefore + 1, '有料(anon_id IS NULL)は部分インデックスの対象外のまま');
});

test('migration 0007: free_generation_locksの24hトリガーが機能する（24h未満は拒否、ちょうど24h以降は許可）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  rawDb.exec(`INSERT INTO free_generation_locks(anon_id,last_success_at) VALUES('anon-1','2026-01-01T00:00:00.000Z')`);

  // 24時間未満 → ABORT
  assert.throws(
    () => rawDb.exec(`UPDATE free_generation_locks SET last_success_at='2026-01-01T23:59:59.000Z' WHERE anon_id='anon-1'`),
    /24h window not yet elapsed/
  );
  // ロールバックされ、元の値のまま
  let row = rawDb.prepare(`SELECT last_success_at FROM free_generation_locks WHERE anon_id='anon-1'`).get();
  assert.equal(row.last_success_at, '2026-01-01T00:00:00.000Z');

  // ちょうど24時間後 → 許可
  rawDb.exec(`UPDATE free_generation_locks SET last_success_at='2026-01-02T00:00:00.000Z' WHERE anon_id='anon-1'`);
  row = rawDb.prepare(`SELECT last_success_at FROM free_generation_locks WHERE anon_id='anon-1'`).get();
  assert.equal(row.last_success_at, '2026-01-02T00:00:00.000Z');

  // 24時間超過 → 許可
  rawDb.exec(`UPDATE free_generation_locks SET last_success_at='2026-01-05T00:00:00.000Z' WHERE anon_id='anon-1'`);
  row = rawDb.prepare(`SELECT last_success_at FROM free_generation_locks WHERE anon_id='anon-1'`).get();
  assert.equal(row.last_success_at, '2026-01-05T00:00:00.000Z');
});

test('migration 0007: free_generation_locksの24hトリガーはbatch()経由でも有効（違反した文を含むbatch全体がロールバックされる）', async () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);
  const db = new D1Shim(rawDb);

  await db.prepare(`INSERT INTO free_generation_locks(anon_id,last_success_at) VALUES('anon-batch','2026-01-01T00:00:00.000Z')`).run();

  await assert.rejects(
    db.batch([
      db.prepare(`INSERT INTO free_generation_log(anon_id,payment_public_id,entitlement_public_id,generated_at) VALUES('anon-batch','pay_x','ent_x','2026-01-01T12:00:00.000Z')`),
      db.prepare(`UPDATE free_generation_locks SET last_success_at='2026-01-01T12:00:00.000Z' WHERE anon_id='anon-batch'`),
    ]),
    /24h window not yet elapsed/
  );

  // batch全体がロールバックされ、free_generation_logへのINSERTも取り消されている
  const logCount = rawDb.prepare(`SELECT COUNT(*) c FROM free_generation_log WHERE anon_id='anon-batch'`).get().c;
  assert.equal(logCount, 0, '24h違反でbatch全体がロールバックされ、24h枠を誤って消費していない（ログも残らない）');
  const lockRow = rawDb.prepare(`SELECT last_success_at FROM free_generation_locks WHERE anon_id='anon-batch'`).get();
  assert.equal(lockRow.last_success_at, '2026-01-01T00:00:00.000Z', 'last_success_atも元のまま（誤って消費されていない）');
});

test('migration 0007: free_generation_logは追記専用（UPDATE/DELETE拒否）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);

  rawDb.exec(`INSERT INTO free_generation_log(anon_id,payment_public_id,entitlement_public_id,generated_at) VALUES('anon-1','pay_x','ent_x','2026-01-01T00:00:00.000Z')`);
  assert.throws(() => rawDb.exec(`UPDATE free_generation_log SET anon_id='anon-2'`), /immutable/);
  assert.throws(() => rawDb.exec(`DELETE FROM free_generation_log`), /immutable/);
});

test('migration 0007: 実際にhandleClaim相当のクエリ(SELECT)が既存(まとめ買い)データに対してエラーなく機能する', async () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, PRE_0007_MIGRATIONS);
  seedPaidData(rawDb);
  applyMigrations(rawDb, ['0007_free_public_beta.sql']);
  const db = new D1Shim(rawDb);

  const row = await db.prepare('SELECT * FROM predictions WHERE prediction_id = ?').bind('pred_2').first();
  assert.equal(row.plan_code, 'pack10');
  assert.equal(row.previous_hash, 'hash_1');
  assert.equal(row.record_hash, 'hash_2');
});
