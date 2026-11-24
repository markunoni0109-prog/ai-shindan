import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './harness.js';
import worker from '../src/index.js';
import { catchUpPredictions, matchPredictionToDraw } from '../src/lib/tracking.js';

async function seed(db) {
  await db.prepare(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES('pay1','free',0,'jpy','paid')`).run();
  await db.prepare(`INSERT INTO purchase_intents(intent_public_id,plan_code,claim_token_hash,status,payment_id) VALUES('i1','pack5','th1','fulfilled',1)`).run();
  await db.prepare(`INSERT INTO purchase_entitlements(entitlement_public_id,payment_id,purchase_intent_id,allowed_predictions,status,claim_token_hash) VALUES('e1',1,1,1,'consumed','th2')`).run();
  await db.prepare(`INSERT INTO predictions(prediction_id,display_sequence,draw_number,number_1,number_2,number_3,number_4,number_5,number_6,combination_key,generated_at,payment_id,entitlement_id,prediction_index,plan_code,algorithm_version,previous_hash,record_hash) VALUES('p1',1,2157,6,13,14,29,33,38,'k1','2026-11-05T08:11:00.000Z',1,1,1,'pack5','v1','GENESIS','h1')`).run();
}
async function draw(db, id, no, date, nums, bonus) {
  await db.prepare(`INSERT INTO lottery_draws(draw_id,draw_number,draw_date,n1,n2,n3,n4,n5,n6,bonus_number,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id, no, date, ...nums, bonus, 't').run();
}

test('追いつき判定: 後から入れた当せん番号を判定し、既存行は変えず、再実行しても増えない', async () => {
  const db = createTestDb();
  await seed(db);
  await draw(db, 'a', 2152, '2026-11-05', [6, 13, 14, 20, 21, 22], 1);
  const p = await db.prepare(`SELECT * FROM predictions WHERE prediction_id='p1'`).first();
  await matchPredictionToDraw(db, p, await db.prepare(`SELECT * FROM lottery_draws WHERE draw_id='a'`).first(), '2026-11-06T00:00:00Z');
  const before = await db.prepare(`SELECT * FROM prediction_matches WHERE draw_id='a'`).first();
  await draw(db, 'b', 2155, '2026-11-16', [6, 13, 14, 29, 40, 41], 2);
  await draw(db, 'c', 2156, '2026-11-19', [1, 2, 3, 4, 5, 7], 8);
  const r = await catchUpPredictions(db);
  assert.equal(r.processed, 1);
  const rows = (await db.prepare(`SELECT draw_id,tracking_type,main_match_count FROM prediction_matches ORDER BY draw_id`).all()).results;
  assert.deepEqual(rows.map((x) => x.draw_id), ['a', 'b', 'c']);
  assert.equal(rows.find((x) => x.draw_id === 'b').main_match_count, 4);
  assert.equal(rows.find((x) => x.draw_id === 'b').tracking_type, 'forward_tracking');
  assert.deepEqual(await db.prepare(`SELECT * FROM prediction_matches WHERE draw_id='a'`).first(), before);
  const r2 = await catchUpPredictions(db);
  assert.equal(r2.processed, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM prediction_matches`).first()).c, 3);
  const s = await db.prepare(`SELECT best_main_match_count FROM prediction_tracking_summary WHERE prediction_id='p1'`).first();
  assert.equal(s.best_main_match_count, 4);
});

test('scheduled は RESEARCH_ENABLED=false でも追いつき判定だけ動く', async () => {
  const db = createTestDb();
  await seed(db);
  await draw(db, 'b', 2155, '2026-11-16', [6, 13, 14, 29, 40, 41], 2);
  const waits = [];
  await worker.scheduled({ scheduledTime: Date.now() }, { DB: db, RESEARCH_ENABLED: 'false' }, { waitUntil: (x) => waits.push(x) });
  await Promise.all(waits);
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM prediction_matches`).first()).c, 1);
});
