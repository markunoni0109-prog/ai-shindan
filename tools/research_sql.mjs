#!/usr/bin/env node
/**
 * 研究用データを本番D1に入れるための「SQL生成」ツール（手元実行。本番には触れない）
 *
 *   node tools/research_sql.mjs pilot  commit_2026-11-09.json  out_pilot.sql
 *   node tools/research_sql.mjs draws  loto6.csv  out_dir  [--schedule-until 2026-12-31]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ZERO_HASH, buildChain, computeCommitHash, defaultDrawAt } from '../src/lib/research.js';

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const sha = (t) => createHash('sha256').update(t).digest('hex');
/** ファイルのSHA-256から決まるUUID形式のID（誰が作っても同じ） */
export function pilotBatchId(fileSha) {
  const h = fileSha;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 11/9の手動事前コミット(JSON)を「試行（手動）」として保存するSQL */
export async function pilotSql(jsonText, drawNumber = 2153) {
  const d = JSON.parse(jsonText);
  const fileSha = sha(jsonText);
  const batchId = pilotBatchId(fileSha);
  const generatedAt = d.generated_at_jst;
  const A = d.groups.analysis, C = d.groups.control;
  const chains = [
    ...(await buildChain({ batchId, grp: 'analysis', tickets: A.tickets, algorithmVersion: A.algorithm, generatedAt, seed: A.seed })),
    ...(await buildChain({ batchId, grp: 'control', tickets: C.tickets, algorithmVersion: C.algorithm, generatedAt, seed: C.seed })),
  ];
  const commit = await computeCommitHash(chains.map((r) => ({ grp: r.grp, ticket_no: r.ticketNo, numbers: r.numbers })));
  const rules = JSON.stringify({ analysis: { algorithm: A.algorithm, ...A.rules }, control: { algorithm: C.algorithm } });
  const out = [];
  out.push('-- 試行（手動）11/9分。抽せん結果(第' + drawNumber + '回)を登録する「前」に実行すること（後だとDBが拒否する）');
  out.push(`-- ファイルSHA-256: ${fileSha}`);
  out.push(
    `INSERT INTO research_batches (batch_id, series, target_draw_number, target_draw_date, generated_at, tickets_per_group, seed_analysis, seed_control, rules_json, prev_batch_hash, evidence_level, source_file_sha256, source_file_text) VALUES (${[
      q(batchId), q('pilot_manual'), drawNumber, q(d.target_draw_date), q(generatedAt), d.tickets_per_group, A.seed, C.seed, q(rules), q(ZERO_HASH), q('file_hash_only'), q(fileSha), q(jsonText),
    ].join(', ')});`
  );
  const PRED_COLS = 'batch_id, grp, ticket_no, number_1, number_2, number_3, number_4, number_5, number_6, combination_key, algorithm_version, generated_at, previous_hash, record_hash';
  const tuple = (r) => `(${[q(batchId), q(r.grp), r.ticketNo, ...r.numbers, q(r.numbers.join('-')), q(r.algorithmVersion), q(r.generatedAt), q(r.previousHash), q(r.recordHash)].join(', ')})`;
  for (let i = 0; i < chains.length; i += 50) {
    out.push(`INSERT INTO research_predictions (${PRED_COLS}) VALUES\n${chains.slice(i, i + 50).map(tuple).join(',\n')};`);
  }
  out.push(`INSERT INTO research_commits (batch_id, commit_hash, ticket_count, committed_at) VALUES (${q(batchId)}, ${q(commit)}, ${chains.length}, ${q(generatedAt)});`);
  return { sql: out.join('\n') + '\n', batchId, fileSha, commit };
}

/** 公式CSV(Shift_JIS相当をデコード済みの文字列)から、抽せん結果と日程のSQLを作る */
export function parseDrawsCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    const [n, date] = [Number(c[0]), c[1]];
    const [y, m, dd] = date.split('/').map(Number);
    const nums = c.slice(2, 8).map(Number).sort((a, b) => a - b);
    const bonus = Number(c[8]);
    if (!(n > 0) || nums.some((x) => !(x >= 1 && x <= 43)) || new Set(nums).size !== 6 || !(bonus >= 1 && bonus <= 43) || nums.includes(bonus)) {
      throw new Error(`不正な行: ${line}`);
    }
    rows.push({ n, date: `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, nums, bonus });
  }
  return rows;
}
const addDays = (iso, k) => new Date(Date.parse(iso + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay(); // 1=月 4=木

/** 最終回の続きを、月・木の規則で仮置き(estimated)。祝日・年末年始は実際と違う場合があるため、必ず確認する */
export function estimateSchedule(lastN, lastDate, untilDate) {
  const out = [];
  let n = lastN, d = lastDate;
  for (;;) {
    do d = addDays(d, 1); while (dow(d) !== 1 && dow(d) !== 4);
    if (d > untilDate) break;
    out.push({ n: ++n, date: d });
  }
  return out;
}

export function drawsSql(csvText, { scheduleUntil = '2026-12-31', chunk = 400, holdFrom = null, onlyFrom = null } = {}) {
  const all = parseDrawsCsv(csvText);
  if (onlyFrom) {
    // 毎週の追加用：指定回以降の結果だけのSQL（日程は含めない）
    const add = all.filter((r) => r.n >= onlyFrom);
    const tup2 = (r) => `(${q('loto6-' + r.n)}, ${r.n}, ${q(r.date)}, ${r.nums.join(', ')}, ${r.bonus}, 'mizuho_csv')`;
    const sql = `INSERT OR IGNORE INTO lottery_draws (draw_id, draw_number, draw_date, n1, n2, n3, n4, n5, n6, bonus_number, source) VALUES\n${add.map(tup2).join(',\n')};\n`;
    return { files: add.length ? [sql] : [], count: all.length, last: all[all.length - 1], heldCount: 0, added: add.length };
  }
  // holdFrom 以降の回は、別ファイル(最後)にまとめる。試行データを先に入れるため
  const rows = holdFrom ? all.filter((r) => r.n < holdFrom) : all;
  const held = holdFrom ? all.filter((r) => r.n >= holdFrom) : [];
  const tup = (r) => `(${q('loto6-' + r.n)}, ${r.n}, ${q(r.date)}, ${r.nums.join(', ')}, ${r.bonus}, 'mizuho_csv')`;
  const multi = (list) => {
    const st = [];
    for (let i = 0; i < list.length; i += 100) {
      st.push(`INSERT OR IGNORE INTO lottery_draws (draw_id, draw_number, draw_date, n1, n2, n3, n4, n5, n6, bonus_number, source) VALUES\n${list.slice(i, i + 100).map(tup).join(',\n')};`);
    }
    return st.join('\n');
  };
  const files = [];
  for (let i = 0; i < rows.length; i += chunk) files.push(multi(rows.slice(i, i + chunk)) + '\n');
  const last = all[all.length - 1];
  const sched = [
    ...all.slice(-30).map((r) => ({ ...r, note: 'csv' })), // 日程表は直近30回＋今後分だけ（古い回は18:45の既定値で足りる）
    ...estimateSchedule(last.n, last.date, scheduleUntil).map((r) => ({ ...r, note: 'estimated: 月木規則。公式発表で要確認' })),
  ].map((r) => `INSERT OR IGNORE INTO draw_schedule (draw_number, draw_date, draw_at, note) VALUES (${r.n}, ${q(r.date)}, ${q(defaultDrawAt(r.date))}, ${q(r.note)});`);
  files.push(sched.join('\n') + '\n');
  if (held.length) files.push('-- 試行データ(1_pilot)を入れた「後」に実行すること\n' + multi(held) + '\n');
  return { files, count: all.length, last, heldCount: held.length };
}

if (process.argv[1] && process.argv[1].endsWith('research_sql.mjs')) {
  const [cmd, input, out] = process.argv.slice(2);
  if (cmd === 'pilot') {
    const r = await pilotSql(readFileSync(input, 'utf8'));
    writeFileSync(out, r.sql);
    console.log(JSON.stringify({ batchId: r.batchId, fileSha: r.fileSha, commit: r.commit }, null, 1));
  } else if (cmd === 'draws') {
    const { TextDecoder } = globalThis;
    const text = new TextDecoder('shift_jis').decode(readFileSync(input));
    const until = process.argv.includes('--schedule-until') ? process.argv[process.argv.indexOf('--schedule-until') + 1] : undefined;
    const of = process.argv.includes('--only-from') ? Number(process.argv[process.argv.indexOf('--only-from') + 1]) : null;
    const hf = process.argv.includes('--hold-from') ? Number(process.argv[process.argv.indexOf('--hold-from') + 1]) : null;
    const r = drawsSql(text, { scheduleUntil: until, holdFrom: hf, onlyFrom: of });
    mkdirSync(out, { recursive: true });
    r.files.forEach((f, i) => writeFileSync(`${out}/draws_${String(i + 1).padStart(2, '0')}.sql`, f));
    console.log(`${r.count}回分 / 最終: 第${r.last.n}回 ${r.last.date} / ファイル${r.files.length}個`);
  } else {
    console.log('使い方: pilot <json> <out.sql> | draws <csv> <out_dir>');
  }
}
