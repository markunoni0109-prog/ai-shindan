import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './harness.js';
import { seedActiveEntitlement } from './seed.js';
import { claimEntitlement } from '../src/lib/db.js';

async function seedOnePrediction(db) {
  const { tokenHash } = await seedActiveEntitlement(db);
  const result = await claimEntitlement(db, tokenHash, { drawNumber: '1850' });
  return result.predictions[0].prediction_id;
}

test('UPDATE predictions は拒否される（トリガーRAISE ABORT）', async () => {
  const db = createTestDb();
  const predictionId = await seedOnePrediction(db);

  await assert.rejects(
    () => db.prepare(`UPDATE predictions SET number_1 = 99 WHERE prediction_id = ?`).bind(predictionId).run(),
    (err) => {
      assert.match(err.message, /immutable/);
      return true;
    }
  );

  // 実際に値が変わっていないことも確認
  const row = await db.prepare('SELECT number_1 FROM predictions WHERE prediction_id=?').bind(predictionId).first();
  assert.notEqual(row.number_1, 99);
});

test('DELETE predictions は拒否される（トリガーRAISE ABORT）', async () => {
  const db = createTestDb();
  const predictionId = await seedOnePrediction(db);

  await assert.rejects(
    () => db.prepare(`DELETE FROM predictions WHERE prediction_id = ?`).bind(predictionId).run(),
    (err) => {
      assert.match(err.message, /immutable/);
      return true;
    }
  );

  const row = await db.prepare('SELECT COUNT(*) AS c FROM predictions WHERE prediction_id=?').bind(predictionId).first();
  assert.equal(row.c, 1, '行が削除されずに残っている');
});

test('UPDATE/DELETEの拒否はbatch()経由でも有効（他の正常な文も含めて全体がロールバックされる）', async () => {
  const db = createTestDb();
  const predictionId = await seedOnePrediction(db);

  const harmless = db.prepare(`SELECT 1`);
  const forbidden = db.prepare(`DELETE FROM predictions WHERE prediction_id = ?`).bind(predictionId);

  await assert.rejects(() => db.batch([harmless, forbidden]));

  const row = await db.prepare('SELECT COUNT(*) AS c FROM predictions WHERE prediction_id=?').bind(predictionId).first();
  assert.equal(row.c, 1, 'batch経由でもDELETEは阻止され、行は残る');
});

test('他テーブル（purchase_entitlements）へのUPDATEはトリガーの影響を受けない', async () => {
  const db = createTestDb();
  const { entitlementId } = await seedActiveEntitlement(db);
  // このUPDATEはpredictionsではないので成功するはず
  const res = await db
    .prepare(`UPDATE purchase_entitlements SET status='consumed' WHERE id=?`)
    .bind(entitlementId)
    .run();
  assert.equal(res.meta.changes, 1);
});
