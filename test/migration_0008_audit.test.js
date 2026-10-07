import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'migrations');
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const PRE = all.filter((f) => f < '0008');
const apply = (db, files) => files.forEach((f) => db.exec(fs.readFileSync(path.join(dir, f), 'utf8')));

/**
 * migration 0008（pack5追加）の本番適用前監査。
 * 0007適用後（=本番候補の現状）相当のデータ（旧'single'行・hash chain・
 * 無料entitlementのanon_id・追跡テーブル）を用意し、0008適用前後で
 * 件数・id・hash・anon_idが不変であること、トリガー/制約が健在であること、
 * 'pack5'/5件が新たに通ることを確認する。
 */
function seed(db) {
  db.exec(`
    INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status,paid_at,stripe_event_id)
    VALUES ('pa1','single',300,'jpy','paid','2026-01-01T00:00:00Z','e1'),
           ('pa2','pack10',2500,'jpy','paid','2026-01-02T00:00:00Z','e2'),
           ('pa3','free',0,'jpy','paid','2026-01-03T00:00:00Z',NULL);
    INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id)
    VALUES ('i1','single','t1','fulfilled',1),('i2','pack10','t2','fulfilled',2);
    INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,consumed_predictions,status,claim_token_hash,consumed_at,anon_id)
    VALUES ('en1',1,1,1,1,'consumed','c1','2026-01-01T00:00:01Z',NULL),
           ('en2',2,2,10,10,'consumed','c2','2026-01-02T00:00:01Z',NULL),
           ('en3',3,NULL,1,0,'active','c3',NULL,'anon-ACTIVE-1');
    INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash)
    VALUES ('p1',1,'PT',1,2,3,4,5,6,'01-02-03-04-05-06','2026-01-01T00:00:01Z',1,1,1,'single','v1','GENESIS','h1'),
           ('p2',2,'PT',7,8,9,10,11,12,'07-08-09-10-11-12','2026-01-02T00:00:01Z',2,2,1,'pack10','v1','h1','h2');
    INSERT INTO prediction_generation_features VALUES ('p1','{"s":1}','2026-01-01T00:00:01Z'),('p2','{"s":2}','2026-01-02T00:00:01Z');
    INSERT INTO free_generation_locks VALUES ('anon-X','2026-01-03T00:00:00Z');
    INSERT INTO free_generation_log(anon_id,payment_public_id,entitlement_public_id,generated_at) VALUES ('anon-X','pa3','en3','2026-01-03T00:00:00Z');
  `);
}
const T = ['payments','purchase_intents','purchase_entitlements','predictions','prediction_generation_features','free_generation_locks','free_generation_log'];
const snap = (db) => Object.fromEntries(T.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]));

test('migration 0008: 適用前後で全行（id・hash・anon_id含む）が完全に不変', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  apply(db, PRE);
  seed(db);
  const before = snap(db);
  apply(db, ['0008_pricing_pack5.sql']);
  const after = snap(db);
  assert.deepEqual(after, before);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'FK違反なし');
  const dangling = db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%_old_0008%' OR sql LIKE '%_old_0007%'").all();
  assert.deepEqual(dangling, [], '壊れたFK参照(old_*)が残らない');
});

test('migration 0008: pack5/5件が通り、旧plan_codeの既存行も維持、不正値は拒否', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  apply(db, PRE); seed(db); apply(db, ['0008_pricing_pack5.sql']);
  db.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES ('pa5','pack5',300,'jpy','paid')`);
  db.exec(`INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash) VALUES ('i5','pack5','t5')`);
  const pid = db.prepare("SELECT id FROM payments WHERE payment_public_id='pa5'").get().id;
  db.exec(`INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash) VALUES ('en5',${pid},5,'active','c5')`);
  assert.throws(() => db.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES ('bad','pack7',1,'jpy','paid')`), /CHECK/);
  assert.throws(() => db.exec(`INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash) VALUES ('en6',${pid},7,'active','c6')`), /CHECK|UNIQUE/);
});

test('migration 0008: immutabilityトリガー・無料枠の部分UNIQUE・24hトリガーが健在', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  apply(db, PRE); seed(db); apply(db, ['0008_pricing_pack5.sql']);
  assert.throws(() => db.exec("UPDATE predictions SET number_1=1 WHERE prediction_id='p1'"), /immutable/);
  assert.throws(() => db.exec("DELETE FROM predictions WHERE prediction_id='p1'"), /immutable/);
  assert.throws(() => db.exec("INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,allowed_predictions,status,claim_token_hash,anon_id) VALUES ('dup',3,1,'active','cdup','anon-ACTIVE-1')"), /UNIQUE/);
  assert.throws(() => db.exec("UPDATE free_generation_locks SET last_success_at='2026-01-03T12:00:00Z' WHERE anon_id='anon-X'"), /24h/);
  assert.throws(() => db.exec("UPDATE free_generation_log SET anon_id='z'"), /immutable/);
});
