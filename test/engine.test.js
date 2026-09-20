import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateNumbers,
  combinationKey,
  canonicalPayload,
  sha256Hex,
  buildPredictionChain,
  GENESIS_HASH,
} from '../src/lib/engine.js';

test('generateNumbers: 6個・1-43・重複なし・昇順（300回）', () => {
  for (let i = 0; i < 300; i++) {
    const nums = generateNumbers();
    assert.equal(nums.length, 6);
    assert.equal(new Set(nums).size, 6, '重複なし');
    for (const n of nums) {
      assert.ok(n >= 1 && n <= 43, `範囲内: ${n}`);
    }
    for (let j = 1; j < nums.length; j++) {
      assert.ok(nums[j - 1] < nums[j], '昇順');
    }
  }
});

test('combinationKey: 固定フォーマット', () => {
  assert.equal(combinationKey([7, 13, 18, 24, 35, 42]), '07-13-18-24-35-42');
  assert.equal(combinationKey([1, 2, 3, 4, 5, 6]), '01-02-03-04-05-06');
});

test('canonicalPayload: 同じ入力なら常に同じ文字列（決定論的）', () => {
  const args = {
    predictionId: 'uuid-1',
    drawNumber: '1850',
    numbers: [7, 13, 18, 24, 35, 42],
    generatedAt: '2026-09-16T00:00:00.000Z',
    paymentPublicId: 'pay_1',
    entitlementPublicId: 'ent_1',
    predictionIndex: 0,
    planCode: 'single',
    algorithmVersion: 'prototype-v1',
    previousHash: GENESIS_HASH,
  };
  const a = canonicalPayload(args);
  const b = canonicalPayload({ ...args });
  assert.equal(a, b);
});

test('canonicalPayload: どれか1フィールドを変えるとhashが変わる', async () => {
  const base = {
    predictionId: 'uuid-1',
    drawNumber: '1850',
    numbers: [7, 13, 18, 24, 35, 42],
    generatedAt: '2026-09-16T00:00:00.000Z',
    paymentPublicId: 'pay_1',
    entitlementPublicId: 'ent_1',
    predictionIndex: 0,
    planCode: 'single',
    algorithmVersion: 'prototype-v1',
    previousHash: GENESIS_HASH,
  };
  const h1 = await sha256Hex(canonicalPayload(base));
  const h2 = await sha256Hex(canonicalPayload({ ...base, previousHash: 'DIFFERENT' }));
  const h3 = await sha256Hex(canonicalPayload({ ...base, numbers: [1, 2, 3, 4, 5, 6] }));
  assert.notEqual(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(h2, h3);
});

test('buildPredictionChain: 単一予測が現在のchain tipへ正しく連結される', async () => {
  const chain = await buildPredictionChain({
    count: 1,
    drawNumber: 'PERMANENT_TRACKING',
    paymentPublicId: 'pay_x',
    entitlementPublicId: 'ent_x',
    planCode: 'single',
    previousHash0: GENESIS_HASH,
    generatedAt: '2026-09-16T00:00:00.000Z',
  });
  assert.equal(chain.length, 1);
  // H0 = GENESIS
  assert.equal(chain[0].previousHash, GENESIS_HASH);
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].previousHash, chain[i - 1].recordHash, `H${i}のprevious_hash = H${i - 1}のrecord_hash`);
  }
  // 各record_hashは実際に再計算しても一致する（canonical payloadの再現性確認）
  for (let i = 0; i < chain.length; i++) {
    const payload = canonicalPayload({
      predictionId: chain[i].predictionId,
      drawNumber: chain[i].drawNumber,
      numbers: chain[i].numbers,
      generatedAt: chain[i].generatedAt,
      paymentPublicId: 'pay_x',
      entitlementPublicId: 'ent_x',
      predictionIndex: chain[i].predictionIndex,
      planCode: chain[i].planCode,
      algorithmVersion: chain[i].algorithmVersion,
      previousHash: chain[i].previousHash,
    });
    const recomputed = await sha256Hex(payload);
    assert.equal(recomputed, chain[i].recordHash, `record #${i}のhash再現性`);
  }
  // 1予測の組み合わせキーを確認
  const keys = chain.map((r) => r.combinationKey);
  assert.equal(new Set(keys).size, 1, '1予測の組み合わせキーが一意');
});
