/**
 * summary.js
 * ------------------------------------------------------------------
 * 【段1：新規追加のみ。既存コードは変更しない】
 * 1) publicSummary(db)       … 認証不要の「全体の追跡成績」。集計値のみ。
 *                               個別の予測数字・prediction_id・個別の照合結果は含めない。
 * 2) purchaserDetail(db,...) … 購入者本人だけが見られる、個別予測の追跡詳細。
 *
 * 当選確率は全組み合わせで同じ。ここで返す値は研究・参考であり、
 * 将来の当選確率が上がる根拠ではない。
 * ------------------------------------------------------------------
 */

const TOTAL_COMBINATIONS = 6096454; // C(43,6)

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** 純ランダムな6数字が、1回の抽せん（本数字6個）と k個一致する確率（k=0..6） */
export function randomMatchProbabilities() {
  const out = {};
  for (let k = 0; k <= 6; k++) out[k] = (comb(6, k) * comb(37, 6 - k)) / TOTAL_COMBINATIONS;
  return out;
}

function emptyDistribution() {
  return { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, '5+B': 0, 6: 0 };
}

/** prediction_matches の集計行（main_match_count, bonus_match, c）を分布へ */
function toDistribution(rows) {
  const d = emptyDistribution();
  for (const r of rows) {
    const main = Number(r.main_match_count);
    const c = Number(r.c || 0);
    if (main === 5 && Number(r.bonus_match) === 1) d['5+B'] += c;
    else d[main] += c;
  }
  return d;
}

export async function publicSummary(db) {
  const total = await db.prepare(`SELECT COUNT(*) AS c FROM predictions`).first();

  const fwdRows = (
    await db
      .prepare(
        `SELECT main_match_count, bonus_match, COUNT(*) AS c
           FROM prediction_matches WHERE tracking_type='forward_tracking'
          GROUP BY main_match_count, bonus_match`
      )
      .all()
  ).results;
  const histRows = (
    await db
      .prepare(
        `SELECT main_match_count, bonus_match, COUNT(*) AS c
           FROM prediction_matches WHERE tracking_type='historical_backtest'
          GROUP BY main_match_count, bonus_match`
      )
      .all()
  ).results;
  const fwdMeta = await db
    .prepare(
      `SELECT COUNT(*) AS comparisons, COUNT(DISTINCT draw_id) AS draws, COUNT(DISTINCT prediction_id) AS predictions
         FROM prediction_matches WHERE tracking_type='forward_tracking'`
    )
    .first();
  const rankRows = (
    await db
      .prepare(
        `SELECT equivalent_rank, COUNT(*) AS c FROM prediction_matches
          WHERE tracking_type='forward_tracking' AND equivalent_rank IS NOT NULL
          GROUP BY equivalent_rank`
      )
      .all()
  ).results;
  const ranks = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rankRows) ranks[r.equivalent_rank] = Number(r.c);

  const head = await db
    .prepare(`SELECT record_hash FROM predictions ORDER BY display_sequence DESC LIMIT 1`)
    .first();

  const fwdDist = toDistribution(fwdRows);
  const histDist = toDistribution(histRows);
  const fwdComparisons = Number(fwdMeta?.comparisons || 0);
  const probs = randomMatchProbabilities();
  const expected = {};
  for (const k of Object.keys(probs)) expected[k] = Number((probs[k] * fwdComparisons).toFixed(4));

  return {
    total_predictions: Number(total.c),
    forward_tracking: {
      predictions_tracked: Number(fwdMeta?.predictions || 0),
      draws_checked: Number(fwdMeta?.draws || 0),
      comparisons: fwdComparisons,
      match_distribution: fwdDist,
      rank_counts: ranks,
    },
    historical_backtest: {
      note: '生成以前の抽せんとの照合。生成後の追跡成績とは別集計。研究・参考値。',
      match_distribution: histDist,
    },
    reference_random: {
      note: '純ランダムな6数字を同じ回数だけ照合した場合の理論上の一致回数（当せん確率は全組み合わせで同じ）。',
      per_comparison_probability: probs,
      expected_forward_counts: expected,
    },
    control_group: { status: 'preparing' },
    chain: {
      length: Number(total.c),
      head_hash: head ? head.record_hash : null,
    },
  };
}

/**
 * 購入者本人の予測1件の追跡詳細。
 * @returns null … 該当なし（他人の予測・存在しない予測を区別しない）
 */
export async function purchaserDetail(db, paymentId, predictionId) {
  const p = await db
    .prepare(
      `SELECT prediction_id, display_sequence, prediction_index,
              number_1, number_2, number_3, number_4, number_5, number_6,
              generated_at, algorithm_version, record_hash
         FROM predictions WHERE prediction_id = ? AND payment_id = ?`
    )
    .bind(predictionId, paymentId)
    .first();
  if (!p) return null;

  const rows = (
    await db
      .prepare(
        `SELECT pm.tracking_type, pm.main_match_count, pm.bonus_match, pm.equivalent_rank,
                pm.elapsed_days, pm.elapsed_draws, d.draw_number, d.draw_date
           FROM prediction_matches pm JOIN lottery_draws d ON d.draw_id = pm.draw_id
          WHERE pm.prediction_id = ?
          ORDER BY d.draw_date DESC, d.draw_number DESC`
      )
      .bind(predictionId)
      .all()
  ).results;

  const forward = rows.filter((r) => r.tracking_type === 'forward_tracking');
  const hist = rows.filter((r) => r.tracking_type === 'historical_backtest');

  const dist = (list) => {
    const d = emptyDistribution();
    for (const r of list) {
      if (r.main_match_count === 5 && r.bonus_match === 1) d['5+B'] += 1;
      else d[r.main_match_count] += 1;
    }
    return d;
  };

  const probs = randomMatchProbabilities();
  const histExpected = {};
  for (const k of Object.keys(probs)) histExpected[k] = Number((probs[k] * hist.length).toFixed(2));

  return {
    prediction_id: p.prediction_id,
    display_id: '#' + String(p.display_sequence).padStart(6, '0'),
    numbers: [p.number_1, p.number_2, p.number_3, p.number_4, p.number_5, p.number_6],
    generated_at: p.generated_at,
    algorithm_version: p.algorithm_version,
    record_hash: p.record_hash,
    forward_tracking: {
      checked_draw_count: forward.length,
      match_distribution: dist(forward),
      matches: forward, // 生成後の抽せんは0個一致も含めて全件
    },
    historical_backtest: {
      note: '生成以前の抽せんとの照合。研究・参考値であり、将来の当せん確率を示すものではありません。',
      checked_draw_count: hist.length,
      match_distribution: dist(hist), // 0個一致も含む全体分布
      expected_for_random: histExpected, // 純ランダムなら期待される回数
      listed_min_match: 3, // 一覧は3個以上一致の回のみ（0〜2個は分布に全件含む）
      matches: hist.filter((r) => r.main_match_count >= 3),
    },
  };
}
