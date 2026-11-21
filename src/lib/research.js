/**
 * research.js — 研究用の自動予測・長期追跡（設計案 v3）
 * ------------------------------------------------------------------
 * 【追加のみ】購入処理・決済・購入者データ・既存API・6球アニメーションには触れない。
 * 研究用データは research_* 表（migrations/0009）に完全に分離する。
 *
 * 当選確率は全組み合わせで同じ。分析版でも上がらない。
 * ここでの分析版の狙いは「当せん時に配当を分け合いにくい構成」と「口同士が重ならないこと」だけ。
 *
 * 分類の基準（設計案 v3 §0-2）:
 *   生成日時 < その抽せんの抽せん開始日時  ⇒ forward_tracking
 *   照合（採点）した日時は、分類に使わない。
 * ------------------------------------------------------------------
 */
import { sha256Hex } from './engine.js';
import { randomMatchProbabilities } from './summary.js';

export const ALGO_ANALYSIS = 'payout-aware-v2';
export const ALGO_CONTROL = 'uniform-random-v1';
export const TICKETS_PER_GROUP = 100;
export const ZERO_HASH = '0'.repeat(64);
export const PAIRS_PER_TICK = 40; // D1問い合わせ50回/回の上限に対し、余裕をみる
export const RULES = {
  max_low31: 3, // 31以下の数字は3個以下
  min_sum: 131, // 合計131以上
  max_pair_overlap: 3, // 他の口との共有数字は3個以下
  freq_cap_ratio: 1.5,
  tries_budget: 20000, // 1回の探索の試行回数の上限（無料プランのCPU 10msを守るため）
  max_attempts: 5, // 失敗時、決まった規則で次のシードを使う（再現できる）
};

/* ------------------------------ 乱数・生成 ------------------------------ */

/** 再現可能な乱数（mulberry32） */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1〜43から6個を一様に選ぶ（Fisher–Yates の先頭6個） */
export function sampleSix(rng) {
  const pool = Array.from({ length: 43 }, (_, i) => i + 1);
  for (let i = 0; i < 6; i++) {
    const j = i + Math.floor(rng() * (43 - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 6).sort((x, y) => x - y);
}

export function frequencyCaps(n, rules = RULES) {
  return {
    low: Math.ceil(((n * 3) / 31) * rules.freq_cap_ratio),
    high: Math.ceil(((n * 3.5) / 12) * 1.3),
  };
}

const low31 = (t) => t.filter((x) => x <= 31).length;
const sum = (t) => t.reduce((a, b) => a + b, 0);
export function payoutAwareOk(t, rules = RULES) {
  return low31(t) <= rules.max_low31 && sum(t) >= rules.min_sum;
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function maskOf(t) {
  let lo = 0, hi = 0;
  for (const x of t) (x <= 32 ? (lo |= 1 << (x - 1)) : (hi |= 1 << (x - 33)));
  return [lo >>> 0, hi >>> 0];
}

export const CHUNK = 25; // 1回の実行（cron）で作る口数。無料プランのCPU 10ms対策
const chunkSeed = (base, c, a) => (base + Math.imul(c, 0x85ebca6b) + Math.imul(a, 0x9e3779b1)) >>> 0;

/** 純ランダム（対照群）の1塊。prev=既に作った口。条件なし・重複する組は除く */
export function controlChunk(prev, k, seed) {
  const rng = makeRng(seed);
  const seen = new Set(prev.map((t) => t.join('-')));
  const out = [];
  while (out.length < k) {
    const t = sampleSix(rng);
    const key = t.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
/** 対照群：塊ごとにシードを進める（塊 c のシード = seed + c × 0x85EBCA6B）。誰でも再現できる */
export function generateControl(n, seed, chunk = CHUNK) {
  const out = [];
  for (let c = 0; out.length < n; c++) out.push(...controlChunk(out, Math.min(chunk, n - out.length), chunkSeed(seed, c, 0)));
  return out;
}

/** 分析版：prev に続けて k 口。見つからなければ null（試行回数の上限つき） */
export function analysisChunk(prev, k, seed, n, rules = RULES) {
  const rng = makeRng(seed);
  const caps = frequencyCaps(n, rules);
  const capOf = (x) => (x <= 31 ? caps.low : caps.high);
  const freq = Array(44).fill(0);
  const masks = [];
  for (const t of prev) {
    t.forEach((x) => freq[x]++);
    masks.push(maskOf(t));
  }
  const out = [];
  let tries = 0;
  while (out.length < k) {
    if (++tries > rules.tries_budget) return null;
    const t = sampleSix(rng);
    if (!payoutAwareOk(t, rules)) continue;
    if (t.some((x) => freq[x] >= capOf(x))) continue;
    const [lo, hi] = maskOf(t);
    let bad = false;
    for (let i = 0; i < masks.length; i++) {
      if (popcount32((masks[i][0] & lo) >>> 0) + popcount32((masks[i][1] & hi) >>> 0) > rules.max_pair_overlap) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    out.push(t);
    masks.push([lo, hi]);
    t.forEach((x) => freq[x]++);
  }
  return out;
}

/**
 * 分析版：決まった規則で塊ごとに作る。塊 c の試行 a のシード = base + c×0x85EBCA6B + a×0x9E3779B1 (mod 2^32)。
 * 塊の探索が行き詰まったら a を進めて同じ塊をやり直す（最大 max_attempts 回）。
 */
export function generateAnalysis(n, baseSeed, rules = RULES, chunk = CHUNK) {
  const out = [];
  let maxAttempt = 0;
  for (let c = 0; out.length < n; c++) {
    const k = Math.min(chunk, n - out.length);
    let got = null;
    for (let a = 0; a < rules.max_attempts && !got; a++) {
      got = analysisChunk(out, k, chunkSeed(baseSeed, c, a), n, rules);
      if (got) maxAttempt = Math.max(maxAttempt, a);
    }
    if (!got) return null;
    out.push(...got);
  }
  return { tickets: out, attempt: maxAttempt, seed: baseSeed };
}

/* ------------------------------ 時刻・分類 ------------------------------ */

/** JST表記のISO文字列（ミリ秒つき・常に +09:00） */
export function jstIso(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}
const epochSec = (iso) => Math.floor(Date.parse(iso) / 1000);

/** 抽せん開始日時（JST）。通常 18:45 */
export function defaultDrawAt(drawDate) {
  return `${drawDate}T18:45:00.000+09:00`;
}

/**
 * 実績の分類（設計案 v3 §0-2）。照合した日時は使わない。
 * 秒単位で比較し、同じ秒は forward にしない（安全側）。
 */
export function classifyTracking(generatedAt, drawAt) {
  return epochSec(generatedAt) < epochSec(drawAt) ? 'forward_tracking' : 'historical_backtest';
}

/** 抽せん日の前日18:00（JST）。この時刻以降、生成を始める */
export function windowStart(drawDate) {
  const d = new Date(`${drawDate}T00:00:00.000+09:00`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${jstIso(d).slice(0, 10)}T18:00:00.000+09:00`;
}

/* ------------------------------ 改ざん防止（ハッシュ） ------------------------------ */

export function ticketLine(grp, ticketNo, numbers) {
  return `${grp},${ticketNo},${numbers.join('-')}`;
}

/** 全口の指紋。分析→対照、口番号の昇順。1行1口、末尾に改行 */
export async function computeCommitHash(rows) {
  const order = { analysis: 0, control: 1 };
  const sorted = [...rows].sort((a, b) => order[a.grp] - order[b.grp] || a.ticket_no - b.ticket_no);
  return sha256Hex(sorted.map((r) => ticketLine(r.grp, r.ticket_no, r.numbers)).join('\n') + '\n');
}

export async function genesisHash(batchId, grp, seed) {
  return sha256Hex(`research-genesis\nbatch_id=${batchId}\ngrp=${grp}\nseed=${seed}`);
}

export function recordPayload({ batchId, grp, ticketNo, numbers, algorithmVersion, generatedAt, previousHash }) {
  return [
    'research-record-v1',
    `batch_id=${batchId}`,
    `grp=${grp}`,
    `ticket_no=${ticketNo}`,
    `numbers=${numbers.join(',')}`,
    `algorithm_version=${algorithmVersion}`,
    `generated_at=${generatedAt}`,
    `previous_hash=${previousHash}`,
  ].join('\n');
}

/** 同バッチ・同群の中で連鎖するレコード列を作る */
export async function buildChain({ batchId, grp, tickets, algorithmVersion, generatedAt, seed, startNo = 1, prevHash = null }) {
  let prev = prevHash || (await genesisHash(batchId, grp, seed));
  const rows = [];
  for (let i = 0; i < tickets.length; i++) {
    const rec = {
      batchId, grp, ticketNo: startNo + i, numbers: tickets[i], algorithmVersion, generatedAt, previousHash: prev,
    };
    const recordHash = await sha256Hex(recordPayload(rec));
    rows.push({ ...rec, recordHash });
    prev = recordHash;
  }
  return rows;
}

const INSERT_PREDICTION = `INSERT INTO research_predictions
  (batch_id, grp, ticket_no, number_1, number_2, number_3, number_4, number_5, number_6,
   combination_key, algorithm_version, generated_at, previous_hash, record_hash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export function insertPredictionStatements(db, chainRows) {
  return chainRows.map((r) =>
    db.prepare(INSERT_PREDICTION).bind(
      r.batchId, r.grp, r.ticketNo, ...r.numbers, r.numbers.join('-'),
      r.algorithmVersion, r.generatedAt, r.previousHash, r.recordHash
    )
  );
}

/* ------------------------------ 定期処理（状態機械） ------------------------------ */

function newBatchId() {
  return crypto.randomUUID();
}
function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

async function setJob(db, targetDrawNumber, step, now, { attemptsInc = 0, error = null } = {}) {
  return db
    .prepare(
      `UPDATE research_jobs SET step = ?, attempts = attempts + ?, last_error = ?, updated_at = ? WHERE target_draw_number = ?`
    )
    .bind(step, attemptsInc, error, jstIso(now), targetDrawNumber);
}

/** ① 計画：次の抽せんの前日18:00（JST）以降に、バッチとジョブを作る */
export async function planStep(db, now, opts = {}) {
  const nowIso = jstIso(now);
  const next = await db
    .prepare(
      `SELECT draw_number, draw_date, draw_at FROM draw_schedule
        WHERE CAST(strftime('%s', draw_at) AS INTEGER) > CAST(strftime('%s', ?) AS INTEGER)
        ORDER BY draw_at ASC LIMIT 1`
    )
    .bind(nowIso)
    .first();
  if (!next) return { did: 'none', reason: 'no_upcoming_draw_in_schedule' };
  if (epochSec(nowIso) < epochSec(windowStart(next.draw_date))) return { did: 'none', reason: 'before_window' };

  const job = await db.prepare(`SELECT step FROM research_jobs WHERE target_draw_number = ?`).bind(next.draw_number).first();
  if (job) return { did: 'none', reason: 'job_exists' };
  const decided = await db.prepare(`SELECT 1 AS x FROM lottery_draws WHERE draw_number = ?`).bind(next.draw_number).first();
  if (decided) return { did: 'none', reason: 'draw_already_decided' };

  const prev = await db
    .prepare(
      `SELECT c.commit_hash FROM research_commits c JOIN research_batches b ON b.batch_id = c.batch_id
        WHERE b.series = 'auto' ORDER BY b.generated_at DESC, c.committed_at DESC LIMIT 1`
    )
    .first();

  const batchId = opts.batchId || newBatchId();
  const seedA = opts.seedAnalysis ?? randomSeed();
  const seedC = opts.seedControl ?? randomSeed();
  await db.batch([
    db
      .prepare(
        `INSERT INTO research_batches
          (batch_id, series, target_draw_number, target_draw_date, generated_at, tickets_per_group,
           seed_analysis, seed_control, rules_json, prev_batch_hash, evidence_level)
         VALUES (?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, 'server_recorded')`
      )
      .bind(
        batchId, next.draw_number, next.draw_date, nowIso, TICKETS_PER_GROUP, seedA, seedC,
        JSON.stringify({ analysis: { algorithm: ALGO_ANALYSIS, ...RULES }, control: { algorithm: ALGO_CONTROL } }),
        prev ? prev.commit_hash : ZERO_HASH
      ),
    db
      .prepare(`INSERT INTO research_jobs (target_draw_number, step, attempts, last_error, updated_at) VALUES (?, 'planned', 0, NULL, ?)`)
      .bind(next.draw_number, nowIso),
  ]);
  return { did: 'planned', batch_id: batchId, target_draw_number: next.draw_number };
}

async function jobBatch(db, step) {
  return db
    .prepare(
      `SELECT j.target_draw_number, j.step, j.attempts, b.batch_id, b.seed_analysis, b.seed_control, b.tickets_per_group,
              b.rules_json, b.generated_at, s.draw_at
         FROM research_jobs j
         JOIN research_batches b ON b.series = 'auto' AND b.target_draw_number = j.target_draw_number
         LEFT JOIN draw_schedule s ON s.draw_number = j.target_draw_number
        WHERE j.step = ? ORDER BY j.target_draw_number ASC LIMIT 1`
    )
    .bind(step)
    .first();
}

const MAX_JOB_ATTEMPTS = 3;

/** ②③④ 生成・指紋。1回の実行で1ステップだけ進める（CPU 10ms対策） */
export async function advanceJob(db, now) {
  for (const [from, kind] of [['planned', 'analysis'], ['analysis_done', 'control'], ['control_done', 'commit']]) {
    const j = await jobBatch(db, from);
    if (!j) continue;
    const nowIso = jstIso(now);
    const drawAt = j.draw_at || null;
    // 抽せん開始後は、生成も指紋も作らない（事前に固定したことを守る）
    if (!drawAt || epochSec(nowIso) >= epochSec(drawAt)) {
      await (await setJob(db, j.target_draw_number, 'expired', now, { error: 'too_late_or_no_schedule' })).run();
      return { did: 'expired', target_draw_number: j.target_draw_number };
    }
    try {
      if (kind === 'commit') return await commitStep(db, j, now);
      return await generateStep(db, j, kind, now);
    } catch (e) {
      const attempts = j.attempts + 1;
      const step = attempts >= MAX_JOB_ATTEMPTS ? 'failed' : from;
      await (await setJob(db, j.target_draw_number, step, now, { attemptsInc: 1, error: String(e.message || e).slice(0, 200) })).run();
      return { did: 'error', target_draw_number: j.target_draw_number, step };
    }
  }
  return { did: 'none' };
}

async function generateStep(db, j, kind, now) {
  const rules = { ...RULES, ...JSON.parse(j.rules_json).analysis };
  const n = j.tickets_per_group;
  const grp = kind === 'analysis' ? 'analysis' : 'control';
  const algo = kind === 'analysis' ? ALGO_ANALYSIS : ALGO_CONTROL;
  const baseSeed = kind === 'analysis' ? j.seed_analysis : j.seed_control;
  const prevRows = (
    await db
      .prepare(
        `SELECT number_1, number_2, number_3, number_4, number_5, number_6, record_hash
           FROM research_predictions WHERE batch_id = ? AND grp = ? ORDER BY ticket_no`
      )
      .bind(j.batch_id, grp)
      .all()
  ).results;
  const done = prevRows.length;
  if (done >= n) throw new Error('already_generated');
  const prev = prevRows.map((r) => [r.number_1, r.number_2, r.number_3, r.number_4, r.number_5, r.number_6]);
  const k = Math.min(CHUNK, n - done);
  const c = Math.floor(done / CHUNK);
  let tickets = null;
  if (kind === 'analysis') {
    for (let a = 0; a < rules.max_attempts && !tickets; a++) tickets = analysisChunk(prev, k, chunkSeed(baseSeed, c, a), n, rules);
    if (!tickets) throw new Error('analysis_generation_failed');
  } else {
    tickets = controlChunk(prev, k, chunkSeed(baseSeed, c, 0));
  }
  const chain = await buildChain({
    batchId: j.batch_id, grp, tickets, algorithmVersion: algo, generatedAt: jstIso(now), seed: baseSeed,
    startNo: done + 1, prevHash: done ? prevRows[done - 1].record_hash : null,
  });
  const finished = done + k >= n;
  const nextStep = !finished ? j.step : kind === 'analysis' ? 'analysis_done' : 'control_done';
  await db.batch([...insertPredictionStatements(db, chain), await setJob(db, j.target_draw_number, nextStep, now)]);
  return { did: kind, target_draw_number: j.target_draw_number, chunk: c, finished };
}

async function commitStep(db, j, now) {
  const rows = (
    await db
      .prepare(
        `SELECT grp, ticket_no, number_1, number_2, number_3, number_4, number_5, number_6
           FROM research_predictions WHERE batch_id = ?`
      )
      .bind(j.batch_id)
      .all()
  ).results.map((r) => ({
    grp: r.grp, ticket_no: r.ticket_no, numbers: [r.number_1, r.number_2, r.number_3, r.number_4, r.number_5, r.number_6],
  }));
  if (rows.length !== j.tickets_per_group * 2) throw new Error('ticket_count_mismatch');
  const hash = await computeCommitHash(rows);
  await db.batch([
    db
      .prepare(`INSERT INTO research_commits (batch_id, commit_hash, ticket_count, committed_at) VALUES (?, ?, ?, ?)`)
      .bind(j.batch_id, hash, rows.length, jstIso(now)),
    await setJob(db, j.target_draw_number, 'committed', now),
  ]);
  return { did: 'commit', target_draw_number: j.target_draw_number, commit_hash: hash };
}

/* ------------------------------ 照合（D1の内部で一括） ------------------------------ */

const DRAW_AT_SQL = `COALESCE(s.draw_at, d.draw_date || 'T18:45:00.000+09:00')`;

/** 1口ごとの一致数 m とボーナス一致 bo を、D1の内部で計算するCTE（?1=batch_id, ?2=draw_id） */
const MATCH_CTE = `
  x AS (
    SELECT p.grp AS grp, p.research_id AS rid,
           ((p.number_1 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6)) + (p.number_2 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6)) +
            (p.number_3 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6)) + (p.number_4 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6)) +
            (p.number_5 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6)) + (p.number_6 IN (d.n1,d.n2,d.n3,d.n4,d.n5,d.n6))) AS m,
           (d.bonus_number IN (p.number_1,p.number_2,p.number_3,p.number_4,p.number_5,p.number_6)) AS bo
      FROM research_predictions p JOIN lottery_draws d ON d.draw_id = ?2
     WHERE p.batch_id = ?1
  )`;

const TALLY_SELECT = `
  SELECT x.grp AS grp,
         COUNT(*) AS tickets_checked,
         SUM(x.m = 0) AS m0, SUM(x.m = 1) AS m1, SUM(x.m = 2) AS m2, SUM(x.m = 3) AS m3, SUM(x.m = 4) AS m4,
         SUM(x.m = 5 AND x.bo = 0) AS m5, SUM(x.m = 5 AND x.bo = 1) AS m5b, SUM(x.m = 6) AS m6,
         SUM(x.m = 6) AS rank1, SUM(x.m = 5 AND x.bo = 1) AS rank2, SUM(x.m = 5 AND x.bo = 0) AS rank3,
         SUM(x.m = 4) AS rank4, SUM(x.m = 3) AS rank5,
         SUM(x.m) AS sum_main_match
    FROM x GROUP BY x.grp`;

/** 保存済みの数字と抽せん結果から、集計を再計算して返す（保存せず、再検証にも使う） */
export async function recomputeTally(db, batchId, drawId) {
  const { results } = await db
    .prepare(`WITH ${MATCH_CTE} ${TALLY_SELECT}`)
    .bind(batchId, drawId)
    .all();
  const out = {};
  for (const r of results) {
    const { grp, ...counts } = r;
    out[grp] = counts;
  }
  return out;
}

/** 未照合の（バッチ × 抽せん）。生成日時 < その抽せんの抽せん開始日時、の組だけ */
export async function pendingPairs(db, limit = PAIRS_PER_TICK) {
  const { results } = await db
    .prepare(
      `SELECT b.batch_id AS batch_id, d.draw_id AS draw_id
         FROM research_batches b
         JOIN research_commits c ON c.batch_id = b.batch_id
         JOIN lottery_draws d
         LEFT JOIN draw_schedule s ON s.draw_number = d.draw_number
        WHERE CAST(strftime('%s', b.generated_at) AS INTEGER) < CAST(strftime('%s', ${DRAW_AT_SQL}) AS INTEGER)
          AND NOT EXISTS (SELECT 1 FROM research_draw_tallies t WHERE t.batch_id = b.batch_id AND t.draw_id = d.draw_id)
        ORDER BY d.draw_date ASC, d.draw_number ASC, b.generated_at ASC
        LIMIT ?`
    )
    .bind(limit)
    .all();
  return results;
}

/** 1組の照合。db.batch() 1回＝1トランザクション（全部成功 or 全部なし） */
export async function scorePair(db, batchId, drawId, now) {
  const scoredAt = jstIso(now);
  const scopeSql = `CASE WHEN d.draw_number = b.target_draw_number THEN 'target' ELSE 'follow_up' END`;
  const elapsedSql = `CAST(julianday(d.draw_date) - julianday(substr(b.generated_at, 1, 10)) AS INTEGER)`;
  const tally = db
    .prepare(
      `WITH ${MATCH_CTE}
       INSERT INTO research_draw_tallies
         (batch_id, grp, draw_id, scope, tracking_type, target_draw_number, draw_number, draw_date, generated_at,
          elapsed_days, draws_after_target, tickets_checked,
          m0, m1, m2, m3, m4, m5, m5b, m6, rank1, rank2, rank3, rank4, rank5, sum_main_match, scored_at)
       SELECT b.batch_id, x.grp, d.draw_id, ${scopeSql}, 'forward_tracking', b.target_draw_number, d.draw_number,
              d.draw_date, b.generated_at, ${elapsedSql}, d.draw_number - b.target_draw_number, COUNT(*),
              SUM(x.m = 0), SUM(x.m = 1), SUM(x.m = 2), SUM(x.m = 3), SUM(x.m = 4),
              SUM(x.m = 5 AND x.bo = 0), SUM(x.m = 5 AND x.bo = 1), SUM(x.m = 6),
              SUM(x.m = 6), SUM(x.m = 5 AND x.bo = 1), SUM(x.m = 5 AND x.bo = 0), SUM(x.m = 4), SUM(x.m = 3),
              SUM(x.m), ?3
         FROM x JOIN research_batches b ON b.batch_id = ?1 JOIN lottery_draws d ON d.draw_id = ?2
        GROUP BY x.grp`
    )
    .bind(batchId, drawId, scoredAt);
  const matches = db
    .prepare(
      `WITH ${MATCH_CTE}
       INSERT INTO research_matches
         (research_id, draw_id, scope, elapsed_days, tracking_type, main_match_count, bonus_match, equivalent_rank, scored_at)
       SELECT x.rid, d.draw_id, ${scopeSql}, ${elapsedSql}, 'forward_tracking', x.m, x.bo,
              CASE WHEN x.m = 6 THEN '1' WHEN x.m = 5 AND x.bo = 1 THEN '2' WHEN x.m = 5 THEN '3'
                   WHEN x.m = 4 THEN '4' WHEN x.m = 3 THEN '5' ELSE NULL END,
              ?3
         FROM x JOIN research_batches b ON b.batch_id = ?1 JOIN lottery_draws d ON d.draw_id = ?2
        WHERE d.draw_number = b.target_draw_number OR x.m >= 3`
    )
    .bind(batchId, drawId, scoredAt);
  const job = db
    .prepare(
      `UPDATE research_jobs SET step = 'scored', updated_at = ?3
        WHERE step = 'committed'
          AND target_draw_number = (SELECT b.target_draw_number FROM research_batches b
                                      JOIN lottery_draws d ON d.draw_id = ?2
                                     WHERE b.batch_id = ?1 AND d.draw_number = b.target_draw_number)`
    )
    .bind(batchId, drawId, scoredAt);
  await db.batch([tally, matches, job]);
}

/** 再検証：保存済みの集計を、数字と抽せん結果から再計算して突き合わせる */
export async function auditSample(db, now, n = 3) {
  const { results } = await db
    .prepare(
      `SELECT t.batch_id AS batch_id, t.draw_id AS draw_id
         FROM research_draw_tallies t
        GROUP BY t.batch_id, t.draw_id
        ORDER BY COALESCE((SELECT MAX(a.checked_at) FROM research_audit_log a WHERE a.batch_id = t.batch_id AND a.draw_id = t.draw_id), '') ASC
        LIMIT ?`
    )
    .bind(n)
    .all();
  const done = [];
  for (const p of results) {
    const fresh = await recomputeTally(db, p.batch_id, p.draw_id);
    const stored = (
      await db
        .prepare(`SELECT * FROM research_draw_tallies WHERE batch_id = ? AND draw_id = ?`)
        .bind(p.batch_id, p.draw_id)
        .all()
    ).results;
    const keys = ['tickets_checked', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5b', 'm6', 'rank1', 'rank2', 'rank3', 'rank4', 'rank5', 'sum_main_match'];
    const diffs = [];
    for (const s of stored) {
      const f = fresh[s.grp];
      if (!f) { diffs.push(`${s.grp}:missing`); continue; }
      for (const k of keys) if (Number(f[k]) !== Number(s[k])) diffs.push(`${s.grp}.${k}:${s[k]}!=${f[k]}`);
    }
    const result = diffs.length ? 'mismatch' : 'match';
    await db
      .prepare(`INSERT INTO research_audit_log (batch_id, draw_id, result, detail, checked_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(p.batch_id, p.draw_id, result, diffs.length ? diffs.join(';').slice(0, 500) : null, jstIso(now))
      .run();
    done.push({ ...p, result });
  }
  return done;
}

/**
 * cron（10分ごと）から呼ばれる。1回の実行は、次のどちらか：
 *   A. 生成の1ステップ（計画／分析版／対照群／指紋）
 *   B. 未照合の組の照合（最大 PAIRS_PER_TICK 組）＋空いていれば再検証
 * enabled が false のときは、何もしない（ドライラン／停止スイッチ）。
 */
export async function runResearchTick(db, now = new Date(), opts = {}) {
  if (opts.enabled === false) return { skipped: 'disabled' };
  const result = { steps: [] };
  const adv = await advanceJob(db, now);
  if (adv.did !== 'none') {
    result.steps.push(adv);
    return result;
  }
  const planned = await planStep(db, now, opts);
  if (planned.did !== 'none') {
    result.steps.push(planned);
    return result;
  }
  const pairs = await pendingPairs(db, opts.pairsPerTick || PAIRS_PER_TICK);
  for (const p of pairs) {
    await scorePair(db, p.batch_id, p.draw_id, now);
    result.steps.push({ did: 'scored', ...p });
  }
  if (!pairs.length) {
    const audited = await auditSample(db, now, opts.auditCount ?? 3);
    if (audited.length) result.steps.push({ did: 'audit', checked: audited.length, mismatches: audited.filter((a) => a.result === 'mismatch').length });
  }
  return result;
}

/* ------------------------------ 公開API用の集計 ------------------------------ */

const P4PLUS = (() => {
  const p = randomMatchProbabilities();
  return p[4] + p[5] + p[6];
})();

/** 公開用の集計。抽せん前の数字は出さない。series・scope・grpは分けたまま返す */
export async function researchPublic(db) {
  const probs = randomMatchProbabilities();
  const batches = (
    await db
      .prepare(
        `SELECT b.batch_id, b.series, b.target_draw_number, b.target_draw_date, b.generated_at, b.tickets_per_group,
                b.evidence_level, c.commit_hash, c.committed_at,
                EXISTS (SELECT 1 FROM research_draw_tallies t WHERE t.batch_id = b.batch_id AND t.scope = 'target') AS target_scored
           FROM research_batches b LEFT JOIN research_commits c ON c.batch_id = b.batch_id
          ORDER BY b.generated_at DESC LIMIT 200`
      )
      .all()
  ).results.map((b) => ({
    batch_id: b.batch_id, series: b.series, target_draw_number: b.target_draw_number, target_draw_date: b.target_draw_date,
    generated_at: b.generated_at, tickets_per_group: b.tickets_per_group, evidence_level: b.evidence_level,
    commit_hash: b.commit_hash || null, committed_at: b.committed_at || null,
    status: !b.commit_hash ? 'generating' : b.target_scored ? 'scored' : 'committed_waiting_draw',
  }));

  const agg = (
    await db
      .prepare(
        `SELECT b.series AS series, t.scope AS scope, t.grp AS grp,
                COUNT(DISTINCT t.batch_id) AS batches, COUNT(DISTINCT t.draw_id) AS draws,
                SUM(t.tickets_checked) AS tickets_checked,
                SUM(t.m0) AS m0, SUM(t.m1) AS m1, SUM(t.m2) AS m2, SUM(t.m3) AS m3, SUM(t.m4) AS m4,
                SUM(t.m5) AS m5, SUM(t.m5b) AS m5b, SUM(t.m6) AS m6,
                SUM(t.rank1) AS rank1, SUM(t.rank2) AS rank2, SUM(t.rank3) AS rank3, SUM(t.rank4) AS rank4, SUM(t.rank5) AS rank5,
                SUM(t.sum_main_match) AS sum_main_match, MIN(t.draw_date) AS first_draw_date, MAX(t.draw_date) AS last_draw_date,
                MAX(t.scored_at) AS last_scored_at
           FROM research_draw_tallies t JOIN research_batches b ON b.batch_id = t.batch_id
          GROUP BY b.series, t.scope, t.grp`
      )
      .all()
  ).results;

  const perDraw = (
    await db
      .prepare(
        `SELECT b.series AS series, t.scope AS scope, t.grp AS grp, t.draw_number AS draw_number, t.draw_date AS draw_date,
                SUM(t.tickets_checked) AS tickets, SUM(t.sum_main_match) AS sum_main_match,
                SUM(t.m3 + t.m4 + t.m5 + t.m5b + t.m6) AS m3plus, SUM(t.m4 + t.m5 + t.m5b + t.m6) AS m4plus
           FROM research_draw_tallies t JOIN research_batches b ON b.batch_id = t.batch_id
          GROUP BY b.series, t.scope, t.grp, t.draw_number, t.draw_date
          ORDER BY t.draw_date ASC, t.draw_number ASC LIMIT 1000`
      )
      .all()
  ).results;

  const byElapsed = (
    await db
      .prepare(
        `SELECT b.series AS series, t.scope AS scope, t.grp AS grp, (t.elapsed_days / 30) AS month_bucket,
                SUM(t.tickets_checked) AS tickets, SUM(t.sum_main_match) AS sum_main_match,
                SUM(t.m3 + t.m4 + t.m5 + t.m5b + t.m6) AS m3plus, SUM(t.m4 + t.m5 + t.m5b + t.m6) AS m4plus
           FROM research_draw_tallies t JOIN research_batches b ON b.batch_id = t.batch_id
          GROUP BY b.series, t.scope, t.grp, (t.elapsed_days / 30)
          ORDER BY b.series, t.scope, t.grp, month_bucket`
      )
      .all()
  ).results;

  // 偶然の曲線との比較：「4個以上を1回以上経験した口」の実績と、理論上の期待
  const perBatchGrp = (
    await db
      .prepare(
        `SELECT b.series AS series, t.grp AS grp, t.batch_id AS batch_id, COUNT(*) AS k, MAX(t.tickets_checked) AS tickets
           FROM research_draw_tallies t JOIN research_batches b ON b.batch_id = t.batch_id
          GROUP BY b.series, t.grp, t.batch_id`
      )
      .all()
  ).results;
  const hit4 = (
    await db
      .prepare(
        `SELECT b.series AS series, p.grp AS grp, COUNT(DISTINCT m.research_id) AS tickets_with_4plus
           FROM research_matches m JOIN research_predictions p ON p.research_id = m.research_id
           JOIN research_batches b ON b.batch_id = p.batch_id
          WHERE m.main_match_count >= 4 GROUP BY b.series, p.grp`
      )
      .all()
  ).results;
  const exposure = {};
  for (const r of perBatchGrp) {
    const key = `${r.series}|${r.grp}`;
    const e = (exposure[key] ||= { series: r.series, grp: r.grp, tickets: 0, expected_tickets_with_4plus: 0, actual_tickets_with_4plus: 0 });
    e.tickets += r.tickets;
    e.expected_tickets_with_4plus += r.tickets * (1 - Math.pow(1 - P4PLUS, r.k));
  }
  for (const h of hit4) {
    const e = exposure[`${h.series}|${h.grp}`];
    if (e) e.actual_tickets_with_4plus = h.tickets_with_4plus;
  }
  for (const e of Object.values(exposure)) e.expected_tickets_with_4plus = Number(e.expected_tickets_with_4plus.toFixed(4));

  return {
    notice: '当せん確率は全組み合わせで同じ。研究によって当せん確率が上がるものではありません。',
    classification: '生成日時が、対象抽せんの開始日時より前なら Forward Tracking。照合した日では決めません。',
    reference_random: { per_comparison_probability: probs, mean_matches: 36 / 43 },
    batches,
    totals: agg,
    per_draw: perDraw,
    by_elapsed_30d: byElapsed,
    exposure_4plus: Object.values(exposure),
  };
}

/** バッチ詳細。対象回の採点が済んでいるバッチだけ、全口の数字と結果を返す。未採点は数字を返さない */
export async function researchBatchPublic(db, batchId) {
  const b = await db
    .prepare(
      `SELECT b.batch_id, b.series, b.target_draw_number, b.target_draw_date, b.generated_at, b.tickets_per_group,
              b.evidence_level, b.prev_batch_hash, b.source_file_sha256, c.commit_hash, c.committed_at
         FROM research_batches b LEFT JOIN research_commits c ON c.batch_id = b.batch_id WHERE b.batch_id = ?`
    )
    .bind(batchId)
    .first();
  if (!b) return null;
  const scored = await db
    .prepare(`SELECT 1 AS x FROM research_draw_tallies WHERE batch_id = ? AND scope = 'target' LIMIT 1`)
    .bind(batchId)
    .first();
  const meta = { ...b, commit_hash: b.commit_hash || null, committed_at: b.committed_at || null };
  if (!scored || !b.commit_hash) return { ...meta, status: b.commit_hash ? 'committed_waiting_draw' : 'generating', tickets: null };

  const tickets = (
    await db
      .prepare(
        `SELECT p.research_id, p.grp, p.ticket_no, p.number_1, p.number_2, p.number_3, p.number_4, p.number_5, p.number_6,
                p.algorithm_version, p.generated_at, p.record_hash,
                m.main_match_count, m.bonus_match, m.equivalent_rank
           FROM research_predictions p
           LEFT JOIN research_matches m ON m.research_id = p.research_id AND m.scope = 'target'
          WHERE p.batch_id = ? ORDER BY p.grp ASC, p.ticket_no ASC`
      )
      .bind(batchId)
      .all()
  ).results.map((r) => ({
    grp: r.grp, ticket_no: r.ticket_no, numbers: [r.number_1, r.number_2, r.number_3, r.number_4, r.number_5, r.number_6],
    algorithm_version: r.algorithm_version, generated_at: r.generated_at, record_hash: r.record_hash,
    target_result: { main_match_count: r.main_match_count, bonus_match: r.bonus_match, equivalent_rank: r.equivalent_rank },
  }));
  return {
    ...meta,
    status: 'scored',
    verify: '各口を「群,口番号,n1-n2-…-n6」の1行にして、分析→対照・口番号順に並べ、末尾に改行を付けた全文のSHA-256が commit_hash と一致します。',
    tickets,
  };
}
