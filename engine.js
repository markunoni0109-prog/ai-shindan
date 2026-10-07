/**
 * engine.js
 * ------------------------------------------------------------------
 * 数字生成・canonical payload・record_hash計算。
 * すべて純粋関数（DB・ネットワークI/Oを持たない）にして、単体テストしやすくする。
 * ------------------------------------------------------------------
 */

export const ALGORITHM_VERSION = 'prototype-v1';
export const SCHEMA_VERSION = 'loto6-prediction-v1';

// FINAL値（v1.1 FINAL / Open承認済み、2026-09-15）。以後変更禁止。
export const GENESIS_HASH = 'AIHUNTER_LOTO6_GENESIS_V1';

const NUMBER_MIN = 1;
const NUMBER_MAX = 43;
const NUMBER_COUNT = 6;

/** 1〜43から重複なし6個を選び昇順で返す */
export function generateNumbers(rng = Math.random) {
  const pool = [];
  for (let n = NUMBER_MIN; n <= NUMBER_MAX; n++) pool.push(n);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, NUMBER_COUNT).sort((a, b) => a - b);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function combinationKey(numbers) {
  return numbers.map(pad2).join('-');
}

/**
 * canonical payloadを固定順序・固定文字列表現で生成する。
 * JSON.stringify(obj)のキー順に依存しない（環境差を避けるため明示的に組み立てる）。
 */
export function canonicalPayload({
  predictionId,
  drawNumber,
  numbers,
  generatedAt,
  paymentPublicId,
  entitlementPublicId,
  predictionIndex,
  planCode,
  algorithmVersion,
  previousHash,
}) {
  const numbersLiteral = '[' + numbers.map((n) => `"${pad2(n)}"`).join(',') + ']';
  return [
    `schema_version=${SCHEMA_VERSION}`,
    `prediction_id=${predictionId}`,
    `draw_number=${drawNumber}`,
    `numbers=${numbersLiteral}`,
    `generated_at=${generatedAt}`,
    `payment_public_id=${paymentPublicId}`,
    `entitlement_public_id=${entitlementPublicId}`,
    `prediction_index=${predictionIndex}`,
    `plan_code=${planCode}`,
    `algorithm_version=${algorithmVersion}`,
    `previous_hash=${previousHash}`,
  ].join('\n');
}

/** SHA-256をhex文字列で返す（Web Crypto API。Workers/ブラウザ/Node18+で共通利用可） */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 1件分のprediction record（DB保存直前の全フィールド）を組み立てる。
 * previous_hashを外から受け取り、record_hashを内部で計算して返す。
 */
export async function buildPredictionRecord({
  drawNumber,
  paymentPublicId,
  entitlementPublicId,
  predictionIndex,
  planCode,
  previousHash,
  generatedAt,
  rng,
}) {
  const numbers = generateNumbers(rng);
  const predictionId = crypto.randomUUID();
  const payload = canonicalPayload({
    predictionId,
    drawNumber,
    numbers,
    generatedAt,
    paymentPublicId,
    entitlementPublicId,
    predictionIndex,
    planCode,
    algorithmVersion: ALGORITHM_VERSION,
    previousHash,
  });
  const recordHash = await sha256Hex(payload);
  return {
    predictionId,
    numbers,
    combinationKey: combinationKey(numbers),
    drawNumber,
    generatedAt,
    predictionIndex,
    planCode,
    algorithmVersion: ALGORITHM_VERSION,
    previousHash,
    recordHash,
  };
}

/**
 * entitlement1件分の予測レコードを生成する。
 * previousHash0はチェーン末尾（呼び出し側が読んで渡す）。
 */
export async function buildPredictionChain({
  count,
  drawNumber,
  paymentPublicId,
  entitlementPublicId,
  planCode,
  previousHash0,
  generatedAt,
  rng,
}) {
  const records = [];
  let prevHash = previousHash0;
  for (let i = 0; i < count; i++) {
    const rec = await buildPredictionRecord({
      drawNumber,
      paymentPublicId,
      entitlementPublicId,
      predictionIndex: i,
      planCode,
      previousHash: prevHash,
      generatedAt,
      rng,
    });
    records.push(rec);
    prevHash = rec.recordHash;
  }
  return records;
}
