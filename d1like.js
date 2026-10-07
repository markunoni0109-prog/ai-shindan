import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

/**
 * SQL文分割（コメント除去・文字列/トリガー本体のセミコロンを考慮）。
 * wrangler/D1の分割と同じ「1文ずつ実行」を再現するための簡易実装。
 */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; } inStr = false; }
      i += 1; continue;
    }
    if (ch === "'") { inStr = true; cur += ch; i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; continue; }
    if (ch === ';') {
      const t = cur.trim();
      const isTrigger = /^CREATE\s+TRIGGER/i.test(t);
      if (isTrigger && !/\bEND$/i.test(t)) { cur += ch; i += 1; continue; }
      cur += ch;
      if (t.length) out.push(cur.trim());
      cur = ''; i += 1; continue;
    }
    cur += ch; i += 1;
  }
  if (cur.trim().length) out.push(cur.trim());
  return out;
}

const isFkPragma = (s) => /^PRAGMA\s+foreign_keys\s*=/i.test(s);

/**
 * 本番D1を模した適用。
 *  - 外部キー制約は常に有効。`PRAGMA foreign_keys=OFF/ON` は無視する
 *    （D1ではトランザクション内で効かない／オフにできないため）。
 *  - mode 'atomic'   : ファイル全体を1トランザクション（失敗時は全ROLLBACK）
 *  - mode 'autocommit': 1文ずつ別トランザクション（失敗時は途中状態が残る＝最悪ケース）
 * 失敗時は { failedStatement } 付きのErrorを投げる。
 */
export function applyD1Like(rawDb, sql, { mode = 'atomic' } = {}) {
  rawDb.exec('PRAGMA foreign_keys = ON');
  const stmts = splitStatements(sql).filter((s) => !isFkPragma(s));
  if (mode === 'atomic') rawDb.exec('BEGIN');
  for (const s of stmts) {
    try {
      rawDb.exec(s);
    } catch (e) {
      if (mode === 'atomic') rawDb.exec('ROLLBACK');
      e.failedStatement = s;
      throw e;
    }
  }
  if (mode === 'atomic') rawDb.exec('COMMIT');
}

export const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
export const readMigration = (f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');

/** 0001〜0006を適用した「本番の現状」相当のDB（ローカルSQLite標準動作）を作る */
export function createProdLikeDbAt0006() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // wranglerが管理する適用履歴テーブル（本番D1と同名）。
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const f of migrationFiles().filter((n) => n <= '0006_zzz')) {
    db.exec(readMigration(f));
    db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(f);
  }
  return db;
}

/**
 * 本番データを模したfixture（0006状態）。
 * 旧single購入・まとめ買い・hash chain・追跡・復旧要求まで、全テーブルに実データを入れる。
 * 本番で確認されている「予測2件」より多めにして網羅する。
 */
export function seedProdLikeData(db) {
  db.exec(`
    INSERT INTO payments(payment_public_id,stripe_checkout_session_id,stripe_payment_intent_id,plan_code,amount,currency,payment_status,paid_at,stripe_event_id,access_token_hash,customer_email_hash)
    VALUES ('pay_1','cs_1','pi_1','single',300,'jpy','paid','2026-09-21T01:00:00Z','evt_1','acc_1','em_1'),
           ('pay_2','cs_2','pi_2','pack10',3000,'jpy','paid','2026-09-22T01:00:00Z','evt_2','acc_2',NULL),
           ('pay_3','cs_3',NULL,'single',300,'jpy','pending',NULL,NULL,NULL,NULL);
    INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id,fulfilled_at,stripe_checkout_session_id,access_token_hash)
    VALUES ('int_1','single','th_1','fulfilled',1,'2026-09-21T01:00:05Z','cs_1','acc_1'),
           ('int_2','pack10','th_2','fulfilled',2,'2026-09-22T01:00:05Z','cs_2','acc_2'),
           ('int_3','single','th_3','pending',NULL,NULL,'cs_3',NULL);
    INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,consumed_predictions,status,claim_token_hash,consumed_at)
    VALUES ('ent_1',1,1,1,1,'consumed','cth_1','2026-09-21T01:00:10Z'),
           ('ent_2',2,2,10,10,'consumed','cth_2','2026-09-22T01:00:10Z');
  `);
  // hash chain（先頭 GENESIS → 以降 previous_hash = 直前 record_hash）。ent_2は10件。
  const ins = db.prepare(`INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let prev = 'AIHUNTER_LOTO6_GENESIS_V1';
  const rows = [];
  rows.push({ pay: 1, ent: 1, idx: 0, plan: 'single' });
  for (let k = 0; k < 10; k++) rows.push({ pay: 2, ent: 2, idx: k, plan: 'pack10' });
  rows.forEach((r, n) => {
    const nums = [n + 1, n + 8, n + 15, n + 22, n + 29, n + 33];
    const hash = `rh_${String(n + 1).padStart(3, '0')}_${'ab'.repeat(8)}`;
    ins.run(`pred_uuid_${n + 1}`, n + 1, 'PERMANENT_TRACKING', ...nums, nums.map((x) => String(x).padStart(2, '0')).join('-'),
      `2026-09-2${1 + (n > 0 ? 1 : 0)}T01:00:${String(10 + n).padStart(2, '0')}Z`, r.pay, r.ent, r.idx, r.plan, 'prototype-v1', prev, hash);
    prev = hash;
  });
  db.exec(`
    INSERT INTO lottery_draws(draw_id,draw_number,draw_date,n1,n2,n3,n4,n5,n6,bonus_number,source)
    VALUES ('draw_1',1999,'2026-09-25',1,2,3,20,21,22,30,'official-test'),('draw_2',2000,'2026-10-02',11,12,13,14,15,16,17,'official-test');
    INSERT INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws,checked_at)
    VALUES ('pred_uuid_1','draw_1','forward_tracking',3,0,'5',4,1,'2026-09-25T12:00:00Z'),
           ('pred_uuid_2','draw_1','historical_backtest',1,0,NULL,NULL,NULL,'2026-09-25T12:00:00Z');
    INSERT INTO prediction_tracking_summary(prediction_id,checked_draw_count,best_main_match_count,best_bonus_match,best_equivalent_rank,best_draw_id,days_to_best,draws_to_best,first_3plus_draw_id,updated_at)
    VALUES ('pred_uuid_1',1,3,0,'5','draw_1',4,1,'draw_1','2026-09-25T12:00:00Z'),
           ('pred_uuid_2',1,1,0,NULL,'draw_1',NULL,NULL,NULL,'2026-09-25T12:00:00Z');
    INSERT INTO prediction_generation_features(prediction_id,features_json,captured_at)
    VALUES ('pred_uuid_1','{"sum":65}','2026-09-21T01:00:10Z'),('pred_uuid_2','{"sum":70}','2026-09-22T01:00:10Z');
    INSERT INTO prediction_results(prediction_id,winning_number_1,winning_number_2,winning_number_3,winning_number_4,winning_number_5,winning_number_6,bonus_number,matched_numbers,match_count,prize_rank,result_source,verified_at)
    VALUES ('pred_uuid_1',1,2,3,20,21,22,30,'[1,2,3]',3,'5等','official-test','2026-09-25T12:00:00Z');
    INSERT INTO recovery_requests(recovery_token_hash,customer_email_hash,expires_at) VALUES ('rt_1','em_1','2026-09-23T00:00:00Z');
    INSERT INTO rate_limit_buckets(bucket_key,window_start,count) VALUES ('claim:ip:1.2.3.4',1000,3);
  `);
}
