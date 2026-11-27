import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNumbers, generateNumbersLowOverlap, isCommonPattern,
  buildPredictionChain, ALGORITHM_VERSION, ALGORITHM_VERSION_LOWOVERLAP, GENESIS_HASH,
} from '../src/lib/engine.js';

test('被りにくいモード: 常に6個・昇順・1〜43・ありがちな選び方を含まない', () => {
  for (let i = 0; i < 3000; i++) {
    const n = generateNumbersLowOverlap();
    assert.equal(n.length, 6);
    assert.equal(new Set(n).size, 6);
    assert.ok(n[0] >= 1 && n[5] <= 43);
    for (let k = 1; k < 6; k++) assert.ok(n[k] > n[k - 1]);
    assert.equal(isCommonPattern(n), false);
  }
});

test('既定(standard)は従来どおり prototype-v1、lowoverlap は別名で記録される', async () => {
  const base = { count: 3, drawNumber: 'PERMANENT_TRACKING', paymentPublicId: 'p', entitlementPublicId: 'e',
    planCode: 'pack5', previousHash0: GENESIS_HASH, generatedAt: '2026-11-27T00:00:00.000Z' };
  const std = await buildPredictionChain(base);
  const low = await buildPredictionChain({ ...base, mode: 'lowoverlap' });
  assert.ok(std.every((r) => r.algorithmVersion === ALGORITHM_VERSION));
  assert.ok(low.every((r) => r.algorithmVersion === ALGORITHM_VERSION_LOWOVERLAP));
  assert.equal(low[0].previousHash, GENESIS_HASH);
  assert.equal(low[1].previousHash, low[0].recordHash);
});

test('固定乱数での通常生成は、被りにくいモード追加前と同じ結果（既存動作を変えていない）', () => {
  let x = 12345; const rng = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x80000000; };
  assert.deepEqual(generateNumbers(rng), [1, 9, 12, 19, 20, 42]);
});

// ---- 通しテスト: claim本文のmode → db → engine → D1保存 ----
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';

const rq = (path, body) => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function freeClaim(anon, extra = {}) {
  const db = createTestDb(); const env = createTestEnv(db);
  const g = await (await worker.fetch(rq('/api/free/generate', { anon_id: anon }), env)).json();
  const res = await worker.fetch(rq('/api/predictions/claim', { claim_token: g.claim_token, ...extra }), env);
  return { res, body: await res.json(), db };
}

test('claimにmode=lowoverlapを付けると lowoverlap-v1 で保存・返却される', async () => {
  const { res, body, db } = await freeClaim('anon-lowoverlap-0001', { mode: 'lowoverlap' });
  assert.equal(res.status, 200);
  assert.equal(body.predictions[0].algorithm_version, 'lowoverlap-v1');
  assert.equal(isCommonPattern(body.predictions[0].numbers), false);
  const row = await db.prepare('SELECT algorithm_version FROM predictions').first();
  assert.equal(row.algorithm_version, 'lowoverlap-v1');
});

test('modeなし・不正なmodeは従来どおり prototype-v1', async () => {
  for (const extra of [{}, { mode: 'xxx' }, { mode: 'standard' }]) {
    const { res, body } = await freeClaim('anon-standard-00001', extra);
    assert.equal(res.status, 200);
    assert.equal(body.predictions[0].algorithm_version, 'prototype-v1');
  }
});
