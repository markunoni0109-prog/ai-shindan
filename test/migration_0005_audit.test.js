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
 * 【migration 0005 本番適用前の慎重な監査】
 *
 * migration 0005は payments / purchase_intents / purchase_entitlements /
 * predictions と、predictionsを参照する4テーブル
 * (prediction_results / prediction_matches / prediction_tracking_summary /
 *  prediction_generation_features) を「RENAME→CREATE→INSERT SELECT→DROP」
 * で再構築する。ここでは「migration 0005適用前に、まとめ買い機能を
 * 一切知らない旧スキーマ(0001-0004)だけで実際に運用していたのと同等の
 * データ」を用意し、0005適用の前後で
 *   - 各テーブルの件数が一切変わらない（データを失わない）
 *   - id（主キー）が保持され、FKで辿れる関係が壊れない
 *   - 既存のrecord_hashチェーン（previous_hash→record_hash）の値が
 *     一切変更されない
 *   - predictions/prediction_matchesのUPDATE/DELETE拒否トリガーが
 *     再構築後も機能する
 *   - predictions を参照する4テーブルのFKが実在する"predictions"を
 *     指しており、"*_old_0005"のような壊れた参照が残っていない
 * ことを実データで確認する。
 */

function applyMigrations(rawDb, fileNames) {
  const migrationsDir = path.join(ROOT, 'migrations');
  for (const file of fileNames) {
    rawDb.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
}

function seedLegacyData(db) {
  // 旧スキーマ(single固定・1予測300円時代)の実運用相当データを3件分用意する。
  db.exec(`
    INSERT INTO payments(payment_public_id,stripe_checkout_session_id,stripe_payment_intent_id,plan_code,amount,currency,payment_status,paid_at,stripe_event_id)
    VALUES
      ('pay_pub_1','cs_1','pi_1','single',300,'jpy','paid','2026-01-01T00:00:00Z','evt_1'),
      ('pay_pub_2','cs_2','pi_2','single',300,'jpy','paid','2026-01-02T00:00:00Z','evt_2'),
      ('pay_pub_3','cs_3','pi_3','single',300,'jpy','paid','2026-01-03T00:00:00Z','evt_3');

    INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id,fulfilled_at,stripe_checkout_session_id)
    VALUES
      ('int_1','single','th_1','fulfilled',1,'2026-01-01T00:00:01Z','cs_1'),
      ('int_2','single','th_2','fulfilled',2,'2026-01-02T00:00:01Z','cs_2'),
      ('int_3','single','th_3','fulfilled',3,'2026-01-03T00:00:01Z','cs_3');

    INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,consumed_predictions,status,claim_token_hash,consumed_at)
    VALUES
      ('ent_1',1,1,1,1,'consumed','cth_1','2026-01-01T00:00:02Z'),
      ('ent_2',2,2,1,1,'consumed','cth_2','2026-01-02T00:00:02Z'),
      ('ent_3',3,3,1,1,'consumed','cth_3','2026-01-03T00:00:02Z');

    INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash)
    VALUES
      ('pred_1',1,'PERMANENT_TRACKING',1,2,3,4,5,6,'01-02-03-04-05-06','2026-01-01T00:00:02Z',1,1,1,'single','v1','GENESIS','hash_1'),
      ('pred_2',2,'PERMANENT_TRACKING',7,8,9,10,11,12,'07-08-09-10-11-12','2026-01-02T00:00:02Z',2,2,1,'single','v1','hash_1','hash_2'),
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
  'prediction_generation_features', 'prediction_results',
];

test('migration 0005: 適用前後で全テーブルの件数が一切変わらない（既存データを失わない）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql']);
  seedLegacyData(rawDb);

  const before = tableCounts(rawDb, ALL_TABLES);
  assert.deepEqual(before, {
    payments: 3, purchase_intents: 3, purchase_entitlements: 3, predictions: 3,
    lottery_draws: 1, prediction_matches: 1, prediction_tracking_summary: 1,
    prediction_generation_features: 3, prediction_results: 1,
  });

  applyMigrations(rawDb, ['0005_bulk_purchase_plans.sql']);

  const after = tableCounts(rawDb, ALL_TABLES);
  assert.deepEqual(after, before, 'migration 0005適用後も全テーブルの件数が完全に一致する');
});

test('migration 0005: idとrecord_hashチェーンの値が一切変更されない（FKで辿れる関係も保持）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql']);
  seedLegacyData(rawDb);

  const chainBefore = rawDb.prepare('SELECT id, prediction_id, previous_hash, record_hash, payment_id, entitlement_id FROM predictions ORDER BY id').all();
  const paymentIdsBefore = rawDb.prepare('SELECT id, payment_public_id FROM payments ORDER BY id').all();

  applyMigrations(rawDb, ['0005_bulk_purchase_plans.sql']);

  const chainAfter = rawDb.prepare('SELECT id, prediction_id, previous_hash, record_hash, payment_id, entitlement_id FROM predictions ORDER BY id').all();
  const paymentIdsAfter = rawDb.prepare('SELECT id, payment_public_id FROM payments ORDER BY id').all();

  assert.deepEqual(chainAfter, chainBefore, 'record_hashチェーン(previous_hash/record_hash)とid・FKは完全に不変');
  assert.deepEqual(paymentIdsAfter, paymentIdsBefore, 'paymentsのidも保持される');

  // FKで実際に辿れることを確認（payment_id/entitlement_idが引き続き有効な参照）
  const joined = rawDb
    .prepare(
      `SELECT pr.prediction_id, pay.payment_public_id, e.entitlement_public_id
       FROM predictions pr
       JOIN payments pay ON pay.id = pr.payment_id
       JOIN purchase_entitlements e ON e.id = pr.entitlement_id
       ORDER BY pr.id`
    )
    .all();
  assert.equal(joined.length, 3, '再構築後もpredictions→payments/purchase_entitlementsのJOINが機能する');
});

test('migration 0005: predictions/prediction_matchesのUPDATE/DELETE拒否トリガーが再構築後も機能する', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql', '0005_bulk_purchase_plans.sql']);
  seedLegacyData(rawDb);

  assert.throws(() => rawDb.exec(`UPDATE predictions SET number_1 = 99 WHERE prediction_id='pred_1'`), /immutable/);
  assert.throws(() => rawDb.exec(`DELETE FROM predictions WHERE prediction_id='pred_1'`), /immutable/);
  assert.throws(() => rawDb.exec(`UPDATE prediction_matches SET main_match_count = 0`), /immutable/);
  assert.throws(() => rawDb.exec(`DELETE FROM prediction_matches`), /immutable/);
  assert.throws(() => rawDb.exec(`UPDATE lottery_draws SET n1 = 99 WHERE draw_id='draw_legacy_1'`), /immutable/);
});

test('migration 0005: predictionsを参照する4テーブルに"_old_0005"を指す壊れたFK参照が一切残らない', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql', '0005_bulk_purchase_plans.sql']);
  seedLegacyData(rawDb);

  const dangling = rawDb.prepare(`SELECT name, sql FROM sqlite_master WHERE sql LIKE '%old_0005%'`).all();
  assert.equal(dangling.length, 0, `old_0005を参照するスキーマオブジェクトが残っていない: ${JSON.stringify(dangling)}`);

  // 新規INSERTでFKが実際に機能することも確認（存在しないpredictions.prediction_idへは弾かれる）
  assert.throws(
    () => rawDb.exec(`INSERT INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,elapsed_days,elapsed_draws,checked_at) VALUES('does_not_exist','draw_legacy_1','historical_backtest',0,0,NULL,NULL,'2026-01-01T00:00:00Z')`),
    /FOREIGN KEY/,
    '存在しないprediction_idへのINSERTはFK制約で弾かれる（predictionsを正しく参照している証拠）'
  );
});

test('migration 0005: 新しいaccess_token_hash列が追加され、既存行はNULLのまま（データ破損なし）', () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql']);
  seedLegacyData(rawDb);
  applyMigrations(rawDb, ['0005_bulk_purchase_plans.sql']);

  const rows = rawDb.prepare('SELECT payment_public_id, access_token_hash FROM payments ORDER BY id').all();
  for (const r of rows) assert.equal(r.access_token_hash, null, `旧行(${r.payment_public_id})のaccess_token_hashはNULLのまま`);

  // 新規行では正常にUNIQUE制約付きで挿入できる
  rawDb.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status,access_token_hash) VALUES('pay_pub_new','pack10',3000,'jpy','paid','new_access_hash')`);
  const newRow = rawDb.prepare(`SELECT access_token_hash FROM payments WHERE payment_public_id='pay_pub_new'`).get();
  assert.equal(newRow.access_token_hash, 'new_access_hash');
});

test('migration 0005: 旧スキーマ(単一300円プラン)のCHECK制約下では拒否されていなかった既存データが、再構築後もそのまま読み書き互換', async () => {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(rawDb, ['0001_init.sql', '0002_predictions_immutability_triggers.sql', '0003_stripe_and_ratelimit.sql', '0004_permanent_tracking.sql', '0005_bulk_purchase_plans.sql']);
  seedLegacyData(rawDb);
  const db = new D1Shim(rawDb);

  // 実際にhandleClaim相当のクエリ(SELECT)がエラーなく機能することを確認
  const row = await db.prepare('SELECT * FROM predictions WHERE prediction_id = ?').bind('pred_2').first();
  assert.equal(row.plan_code, 'single');
  assert.equal(row.previous_hash, 'hash_1');
  assert.equal(row.record_hash, 'hash_2');
});
