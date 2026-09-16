/**
 * engine.js
 * ------------------------------------------------------------------
 * 予測生成ロジック。UIから完全に分離する。
 *
 * 現在の実装は prototype-v1（1〜43から重複なし6個をランダム抽出→昇順）。
 * 将来 AI HUNTER 独自ロジック（algorithm-v1, v2...）に差し替える際は
 * この関数の中身だけを置き換えればよく、UI・演出・履歴側は変更不要。
 * ------------------------------------------------------------------
 */

const ALGORITHM_VERSION = 'prototype-v1';
const NUMBER_MIN = 1;
const NUMBER_MAX = 43;
const NUMBER_COUNT = 6;

/**
 * 1〜43から重複なしで6個を選び、昇順で返す。
 * @returns {number[]} length === NUMBER_COUNT, ascending, unique
 */
function generateNumbers() {
  const pool = [];
  for (let n = NUMBER_MIN; n <= NUMBER_MAX; n++) pool.push(n);

  // Fisher–Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, NUMBER_COUNT).sort((a, b) => a - b);
}

/**
 * 予測1件分のペイロードを生成する（DB保存前のデータ）。
 * @param {number} drawNumber 対象回号
 * @returns {{numbers:number[], drawNumber:number, algorithmVersion:string, generatedAt:string}}
 */
function generatePrediction(drawNumber) {
  return {
    numbers: generateNumbers(),
    drawNumber,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAt: new Date().toISOString(),
  };
}

window.LotoEngine = {
  generatePrediction,
  NUMBER_MIN,
  NUMBER_MAX,
  NUMBER_COUNT,
  ALGORITHM_VERSION,
};
