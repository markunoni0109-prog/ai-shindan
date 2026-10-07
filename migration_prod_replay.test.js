import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { D1Shim } from './d1shim.js';
import { createTestEnv } from './harness.js';
import worker from '../src/index.js';
import { hashClaimToken } from '../src/lib/tokens.js';
import { PLAN_CATALOG } from '../src/lib/plans.js';
import { signStripePayload, buildCheckoutSessionCompletedEvent, TEST_STRIPE_WEBHOOK_SECRET } from './stripeMock.js';
import {
  createProdLikeDbAt0006, seedProdLikeData, applyD1Like, readMigration, MIGRATIONS_DIR,
} from './support/d1like.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LEGACY_FAILED_0007 = fs.readFileSync(path.join(HERE, 'support', 'legacy_failed_0007.sql'), 'utf8');
const AUDIT_SQL = fs.readFileSync(path.join(ROOT, 'scripts', 'prod-audit.sql'), 'utf8');
const NEW = ['0007_free_public_beta.sql', '0008_pricing_pack5.sql'];
const MODES = ['atomic', 'autocommit', 'local'];

/**
 * 【本番D1 migration失敗（FOREIGN KEY constraint failed）の再現と修正の検証】
 *
 * 本番D1は外部キーが常時有効で、`PRAGMA foreign_keys=OFF` は効かない。
 * このテストは本番相当データ(test/support/d1like.js)を0001〜0006状態に入れ、
 *   atomic    : ファイル全体を1トランザクションで適用（失敗時は全ROLLBACK）
 *   autocommit: 1文ずつ適用（失敗時は途中状態が残る＝最悪ケース）
 *   local     : ローカルSQLite標準（PRAGMA foreign_keys=OFFが有効）
 * の3方式で、修正版0007→0008を適用して全項目を確認する。
 */

const TABLES = ['payments', 'purchase_intents', 'purchase_entitlements', 'predictions', 'prediction_results',
  'prediction_matches', 'prediction_tracking_summary', 'prediction_generation_features', 'lottery_draws', 'recovery_requests', 'rate_limit_buckets'];
// 0006時点の全列（比較は「適用前に存在した列」で行う。anon_idは新規列なので別途NULLを確認）
const colsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
function snapshot(db, cols0006) {
  const out = {};
  for (const t of TABLES) {
    const order = cols0006[t].includes('id') ? 'id' : cols0006[t][0];
    out[t] = db.prepare(`SELECT ${cols0006[t].join(',')} FROM ${t} ORDER BY ${order}`).all().map((r) => ({ ...r }));
  }
  return out;
}
function migrate(db, files, mode) {
  for (const f of files) {
    if (mode === 'local') { db.exec('PRAGMA foreign_keys = ON'); db.exec(readMigration(f)); } else applyD1Like(db, readMigration(f), { mode });
  }
}
function prodLike() {
  const db = createProdLikeDbAt0006();
  seedProdLikeData(db);
  const cols = Object.fromEntries(TABLES.map((t) => [t, colsOf(db, t)]));
  return { db, cols, before: snapshot(db, cols) };
}

// ---------------------------------------------------------------- 原因の再現
test('【原因】旧0007は本番相当データで「DROP TABLE payments_old_0007;」がFOREIGN KEY constraint failedになる（atomic/autocommit両方）', () => {
  for (const mode of ['atomic', 'autocommit']) {
    const { db } = prodLike();
    assert.throws(
      () => applyD1Like(db, LEGACY_FAILED_0007, { mode }),
      (e) => {
        assert.match(e.message, /FOREIGN KEY constraint failed/);
        assert.equal(e.errcode, 787, 'SQLITE_CONSTRAINT_FOREIGNKEY');
        assert.equal(e.failedStatement, 'DROP TABLE payments_old_0007;', `mode=${mode}`);
        return true;
      }
    );
  }
});

test('【原因】同じ旧0007でも、子テーブルに行が無ければ成功する（＝0005が過去の本番で通った理由の再現。本番履歴の確認ではなく仕組みの再現）', () => {
  const db = createProdLikeDbAt0006(); // データ無し
  applyD1Like(db, LEGACY_FAILED_0007, { mode: 'atomic' });
});

test('【原因】旧0007のatomic失敗は完全ロールバック、autocommit失敗は途中状態(payments_old_0007残存)が残る', () => {
  const a = prodLike();
  assert.throws(() => applyD1Like(a.db, LEGACY_FAILED_0007, { mode: 'atomic' }));
  assert.deepEqual(snapshot(a.db, a.cols), a.before, 'atomic: 失敗後も既存データ完全不変');
  assert.equal(a.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='payments_old_0007'").get().c, 0);

  const b = prodLike();
  assert.throws(() => applyD1Like(b.db, LEGACY_FAILED_0007, { mode: 'autocommit' }));
  assert.equal(b.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='payments_old_0007'").get().c, 1, 'autocommit: 途中状態が残る');
});

// ---------------------------------------------------------------- 修正版の再現適用
for (const mode of MODES) {
  test(`【修正版】0001→0006状態＋本番相当データ → 0007 → 0008 が成功し、既存データが完全一致 [${mode}]`, () => {
    const { db, cols, before } = prodLike();
    migrate(db, NEW, mode);

    // 全テーブルの全行（適用前に存在した全列）が完全一致＝行数・id・prediction_id・6数字・
    // generated_at・algorithm_version・previous_hash・record_hash・payment/entitlement・追跡
    assert.deepEqual(snapshot(db, cols), before);

    // anon_idは新列：既存の有料entitlementは全てNULL
    assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_entitlements WHERE anon_id IS NOT NULL').get().c, 0);

    // 外部キー整合・DB整合・残骸なし
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const leftovers = db.prepare("SELECT name FROM sqlite_master WHERE instr(name,'_old_00')>0 OR instr(name,'_bk00')>0 OR instr(name,'_mig00')>0 OR instr(sql,'_old_00')>0").all();
    assert.deepEqual(leftovers, []);

    // hash chain（GENESIS起点・previous_hash=直前record_hash）が前後で無傷
    const chain = db.prepare('SELECT display_sequence, previous_hash, record_hash FROM predictions ORDER BY display_sequence').all();
    assert.equal(chain[0].previous_hash, 'AIHUNTER_LOTO6_GENESIS_V1');
    for (let i = 1; i < chain.length; i++) assert.equal(chain[i].previous_hash, chain[i - 1].record_hash);
    assert.equal(chain.length, before.predictions.length);

    // CHECK制約: free / pack5 / 5件が通り、不正値は拒否
    db.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES ('t_free','free',0,'jpy','paid'),('t_p5','pack5',300,'jpy','paid')`);
    assert.throws(() => db.exec(`INSERT INTO payments(payment_public_id,plan_code,amount,currency,payment_status) VALUES ('t_bad','pack7',1,'jpy','paid')`), /CHECK/);

    // immutability・無料枠制約が健在
    assert.throws(() => db.exec("UPDATE predictions SET number_1=number_1 WHERE id=1"), /immutable/);
    assert.throws(() => db.exec('DELETE FROM predictions WHERE id=1'), /immutable/);
    assert.throws(() => db.exec("UPDATE prediction_matches SET main_match_count=0"), /immutable/);
    const trg = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
    for (const n of ['trg_predictions_no_update', 'trg_predictions_no_delete', 'trg_prediction_matches_no_update', 'trg_prediction_matches_no_delete',
      'trg_lottery_draws_no_update', 'trg_lottery_draws_no_delete', 'trg_free_lock_24h', 'trg_free_generation_log_no_update', 'trg_free_generation_log_no_delete']) {
      assert.ok(trg.includes(n), `trigger ${n}`);
    }
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    for (const n of ['idx_one_active_free_entitlement_per_anon', 'idx_payments_customer_email_hash', 'idx_purchase_intents_session_id',
      'idx_predictions_entitlement', 'idx_predictions_created_at', 'idx_predictions_payment', 'idx_prediction_matches_prediction', 'idx_prediction_matches_draw']) {
      assert.ok(idx.includes(n), `index ${n}`);
    }
  });
}

test('【修正版】0007単体を適用した状態（0008未適用）でも既存データ完全一致・FK整合', () => {
  for (const mode of MODES) {
    const { db, cols, before } = prodLike();
    migrate(db, [NEW[0]], mode);
    assert.deepEqual(snapshot(db, cols), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

// ---------------------------------------------------------------- 安全ガード
test('【ガード】復元が1行でも欠けたらmigrationは失敗し、atomicなら全ロールバック／autocommitなら退避テーブルが残る', () => {
  // 復元の途中で1行だけ欠落させる（外部キー違反にならない末端テーブルで、ガードだけが検出できる破損を再現）
  const sql = readMigration(NEW[0]).replace('FROM _bk0007_prediction_generation_features;', "FROM _bk0007_prediction_generation_features WHERE prediction_id <> 'pred_uuid_2';");
  assert.notEqual(sql, readMigration(NEW[0]));

  const a = prodLike();
  assert.throws(() => applyD1Like(a.db, sql, { mode: 'atomic' }), /CHECK constraint failed/);
  assert.deepEqual(snapshot(a.db, a.cols), a.before, 'atomic: 失敗しても既存データは1行も変わらない');

  const b = prodLike();
  assert.throws(() => applyD1Like(b.db, sql, { mode: 'autocommit' }), /CHECK constraint failed/);
  assert.equal(b.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='_bk0007_prediction_generation_features'").get().c, 1, 'autocommit: 退避テーブルが残り、データは復元可能');
  assert.equal(b.db.prepare('SELECT COUNT(*) c FROM _bk0007_prediction_generation_features').get().c, b.before.prediction_generation_features.length);
  assert.equal(b.db.prepare('SELECT COUNT(*) c FROM _bk0007_predictions').get().c, b.before.predictions.length, '予測の退避も無傷');
});

test('【復旧】旧0007がautocommitで途中失敗した状態（payments_old_0007残存）に修正版を適用しても、既存データは完全一致', () => {
  const { db, cols, before } = prodLike();
  assert.throws(() => applyD1Like(db, LEGACY_FAILED_0007, { mode: 'autocommit' }));
  migrate(db, NEW, 'autocommit');
  assert.deepEqual(snapshot(db, cols), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  // 旧版の残骸テーブルは自動削除しない（データを勝手に消さない）。監査SQLが検出する。
  const left = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND instr(name,'_old_00')>0").all().map((r) => r.name);
  assert.deepEqual(left, ['payments_old_0007']);
});

// ---------------------------------------------------------------- 監査SQL
const runAudit = (db) => Object.fromEntries(db.prepare(AUDIT_SQL).all().map((r) => [r.check_name, r.value]));

test('【監査SQL】読み取り専用（SELECT1文のみ）で、本番相当DBの適用前/適用後の状態を正しく判定する', () => {
  const code = AUDIT_SQL.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''"); // コメントと文字列リテラルを除いた実コード
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|VACUUM)\b/i);
  assert.equal(AUDIT_SQL.replace(/--.*$/gm, '').trim().split(';').filter((s) => s.trim()).length, 1, '1文のみ');

  const { db } = prodLike();
  const pre = runAudit(db);
  assert.equal(pre.A1_applied_migrations.split(' | ').length, 6);
  assert.equal(pre.A2_partial_leftover_count, 0);
  assert.equal(pre.B1_free_tables_present, 0);
  assert.equal(pre.B2_entitlements_has_anon_id, 0);
  assert.equal(pre.B4_payments_check_allows_pack5, 0);
  for (const k of Object.keys(pre).filter((x) => x.startsWith('E'))) assert.equal(pre[k], 0, k);
  assert.equal(pre.D6_hash_chain_breaks, 0);
  assert.equal(pre.F1_consumed_entitlement_mismatch, 0);
  assert.equal(pre.D5_first_previous_hash, 'AIHUNTER_LOTO6_GENESIS_V1');

  migrate(db, NEW, 'atomic');
  for (const f of NEW) db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(f);
  const post = runAudit(db);
  assert.equal(post.A1_applied_migrations.split(' | ').length, 8);
  assert.equal(post.A2_partial_leftover_count, 0);
  assert.equal(post.B1_free_tables_present, 2);
  assert.equal(post.B2_entitlements_has_anon_id, 1);
  assert.equal(post.B3_payments_check_allows_free, 1);
  assert.equal(post.B4_payments_check_allows_pack5, 1);
  assert.equal(post.B5_entitlements_allows_5, 1);
  // 適用前後で変わってはいけない指標
  for (const k of Object.keys(pre).filter((x) => /^(C_|D[1-8]_|E|F)/.test(x))) assert.equal(post[k], pre[k], `前後一致: ${k}`);
});

test('【監査SQL】旧0007の途中失敗状態（残骸）を A2_partial_leftover_count で検出する', () => {
  const { db } = prodLike();
  assert.throws(() => applyD1Like(db, LEGACY_FAILED_0007, { mode: 'autocommit' }));
  const r = runAudit(db);
  assert.ok(r.A2_partial_leftover_count > 0);
  assert.match(r.A3_partial_leftover_names, /payments_old_0007/);
});

// ---------------------------------------------------------------- 移行後のアプリ動作（回帰）
const req = (method, p, body, env) =>
  worker.fetch(new Request(`http://localhost${p}`, { method, headers: { 'content-type': 'application/json', Origin: 'https://ai-hunter.jp' }, body: body ? JSON.stringify(body) : undefined }), env);
const webhook = async (env, ev) => {
  const raw = JSON.stringify(ev);
  return worker.fetch(new Request('http://localhost/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': await signStripePayload(raw, TEST_STRIPE_WEBHOOK_SECRET) }, body: raw }), env);
};
function migratedEnv(mode = 'atomic') {
  const p = prodLike();
  migrate(p.db, NEW, mode);
  return { ...p, env: createTestEnv(new D1Shim(p.db)) };
}

test('【回帰】移行後: FREE生成→claim→prediction_id・追跡登録・リロード同一・24時間制御、既存予測は無傷', async () => {
  const { db, env, cols, before } = migratedEnv();
  const tail = before.predictions.at(-1).record_hash;
  const g = await (await req('POST', '/api/free/generate', { anon_id: 'replay-anon-0001' }, env)).json();
  assert.equal(g.outcome, 'created');
  const c = await (await req('POST', '/api/predictions/claim', { claim_token: g.claim_token }, env)).json();
  assert.equal(c.predictions.length, 1);
  assert.ok(c.predictions[0].prediction_id);
  const row = db.prepare('SELECT previous_hash, plan_code FROM predictions WHERE prediction_id=?').get(c.predictions[0].prediction_id);
  assert.equal(row.previous_hash, tail, '既存hash chainの末尾に連結される');
  assert.equal(row.plan_code, 'free');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM prediction_generation_features WHERE prediction_id=?').get(c.predictions[0].prediction_id).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM prediction_tracking_summary WHERE prediction_id=?').get(c.predictions[0].prediction_id).c, 1);
  const again = await (await req('POST', '/api/predictions/claim', { claim_token: g.claim_token }, env)).json();
  assert.equal(again.outcome, 'existing');
  assert.equal(again.predictions[0].prediction_id, c.predictions[0].prediction_id);
  const lim = await req('POST', '/api/free/generate', { anon_id: 'replay-anon-0001' }, env);
  assert.equal(lim.status, 429);
  assert.equal((await lim.json()).error.code, 'free_limit_not_elapsed');
  // 既存の11件は1列も変わらない
  const afterOld = snapshot(db, cols).predictions.slice(0, before.predictions.length);
  assert.deepEqual(afterOld, before.predictions);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

for (const [code, spec] of Object.entries({ pack5: [300, 5], pack10: [500, 10], pack30: [1000, 30], pack50: [1500, 50] })) {
  test(`【回帰】移行後: ${code} = ${spec[0]}円/${spec[1]}件。Stripe金額・全件保存・hash chain・追跡・claim再実行・Webhook重複・既存データ無傷`, async () => {
    const { db, env, cols, before } = migratedEnv();
    const cr = await req('POST', '/api/checkout/create', { plan_code: code }, env);
    assert.equal(cr.status, 200);
    const body = await cr.json();
    assert.equal(body.amount, spec[0]);
    assert.equal(body.allowed_predictions, spec[1]);
    assert.equal(PLAN_CATALOG[code].amount, spec[0]);
    const sess = db.prepare('SELECT stripe_checkout_session_id s FROM purchase_intents WHERE claim_token_hash=?').get(await hashClaimToken(body.claim_token)).s;
    const ev = buildCheckoutSessionCompletedEvent({ eventId: `evt_replay_${code}`, sessionId: sess, amountTotal: spec[0], paymentIntentId: `pi_replay_${code}` });
    assert.equal((await webhook(env, ev)).status, 200);
    assert.equal((await webhook(env, ev)).status, 200); // 重複配信
    assert.equal(db.prepare("SELECT COUNT(*) c FROM payments WHERE stripe_event_id=?").get(`evt_replay_${code}`).c, 1);
    const c1 = await (await req('POST', '/api/predictions/claim', { claim_token: body.claim_token }, env)).json();
    const c2 = await (await req('POST', '/api/predictions/claim', { claim_token: body.claim_token }, env)).json();
    assert.equal(c1.outcome, 'created');
    assert.equal(c1.predictions.length, spec[1]);
    assert.deepEqual(c2.predictions.map((p) => p.prediction_id), c1.predictions.map((p) => p.prediction_id));
    const total = db.prepare('SELECT COUNT(*) c FROM predictions').get().c;
    assert.equal(total, before.predictions.length + spec[1]);
    const newRows = db.prepare('SELECT prediction_id, combination_key, previous_hash, record_hash FROM predictions WHERE id > ? ORDER BY id').all(before.predictions.length);
    assert.equal(new Set(newRows.map((r) => r.prediction_id)).size, spec[1]);
    assert.equal(new Set(newRows.map((r) => r.combination_key)).size, spec[1]);
    assert.equal(newRows[0].previous_hash, before.predictions.at(-1).record_hash);
    for (let i = 1; i < newRows.length; i++) assert.equal(newRows[i].previous_hash, newRows[i - 1].record_hash);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM prediction_generation_features').get().c, before.prediction_generation_features.length + spec[1]);
    assert.deepEqual(snapshot(db, cols).predictions.slice(0, before.predictions.length), before.predictions);
    assert.deepEqual(snapshot(db, cols).payments.slice(0, before.payments.length), before.payments);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('【回帰】移行後: 金額不一致のWebhookは購入権を発行しない（fail-close）', async () => {
  const { db, env } = migratedEnv();
  const body = await (await req('POST', '/api/checkout/create', { plan_code: 'pack5' }, env)).json();
  const sess = db.prepare('SELECT stripe_checkout_session_id s FROM purchase_intents WHERE claim_token_hash=?').get(await hashClaimToken(body.claim_token)).s;
  const before = db.prepare('SELECT COUNT(*) c FROM purchase_entitlements').get().c;
  const r = await webhook(env, buildCheckoutSessionCompletedEvent({ eventId: 'evt_bad_amt', sessionId: sess, amountTotal: 299, paymentIntentId: 'pi_bad' }));
  assert.equal((await r.json()).ignored, 'amount_mismatch');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM purchase_entitlements').get().c, before);
});
