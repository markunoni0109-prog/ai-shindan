-- 【テスト専用・適用禁止】2026-10-07に本番D1で DROP TABLE payments_old_0007 が FOREIGN KEY constraint failed となった旧版0007そのもの。
-- 失敗の再現と、失敗後の途中状態からの復旧テストにのみ使う。migrations/ には置かない。
-- ============================================================
-- STEP 5: FREE PUBLIC BETA（無料公開ベータ）対応
--
-- 計画書: claude/T-002_FREE_PUBLIC_BETA_実装計画書_2026-09-26.md（v2最終版）
--
-- 変更内容：
--   1) payments / predictions の CHECK 制約に plan_code='free' を追加
--      （SQLiteはCHECK制約をALTERできないため、0005と同じ
--       「テーブル再作成→データコピー（id保持）→FK再接続」の手順を踏襲する）
--   2) purchase_entitlements に anon_id 列を追加し、
--      「同一anon_idの未消費(active)free entitlementは同時に1つまで」を
--      部分UNIQUEインデックスでDB自身に保証させる
--      （＝ entitlement発行直後・claim前の通信断からの復旧時に、
--        二重にentitlement/paymentが作られないようにするための制約）
--   3) free_generation_locks を新設し、「claim成功時刻から24時間」を
--      BEFORE UPDATEトリガーで原子的に強制する
--      （24時間枠は"entitlement発行成功"ではなく"claimが実際に成功した時点"
--       でのみ消費される。呼び出し元はsrc/index.jsのhandleClaim()で、
--       claimEntitlement()自体は一切変更しない）
--   4) free_generation_log を新設し、無料生成の実績（継続利用・累計件数等の
--      分析）を追記専用ログとして残す
--
-- 【本番適用時の注意】このファイルはCloudflare D1へ
--   wrangler d1 migrations apply <DB> --remote
-- で適用すること。適用後、必ず remote 環境で
--   - predictions への UPDATE/DELETE がABORTされること
--   - free_generation_locksの24hトリガーが機能すること
--   - idx_one_active_free_entitlement_per_anon が機能すること
--   - 既存の決済・予測件数が変わっていないこと（SELECT COUNT(*)）
-- を実機で再確認すること（migrations/0002・0005のコメント参照）。
-- ============================================================

PRAGMA foreign_keys=OFF;

-- ---------- payments ----------
ALTER TABLE payments RENAME TO payments_old_0007;

CREATE TABLE payments (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_public_id           TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  plan_code                   TEXT NOT NULL CHECK (plan_code IN ('single','pack10','pack30','pack50','free')),
  amount                      INTEGER NOT NULL,
  currency                    TEXT NOT NULL DEFAULT 'jpy' CHECK (currency = 'jpy'),
  payment_status              TEXT NOT NULL DEFAULT 'pending'
                               CHECK (payment_status IN ('pending','paid','failed')),
  paid_at                     TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stripe_event_id             TEXT UNIQUE,
  access_token_hash           TEXT UNIQUE,
  customer_email_hash         TEXT
);

INSERT INTO payments
  (id, payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
   plan_code, amount, currency, payment_status, paid_at, created_at, stripe_event_id,
   access_token_hash, customer_email_hash)
SELECT
   id, payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
   plan_code, amount, currency, payment_status, paid_at, created_at, stripe_event_id,
   access_token_hash, customer_email_hash
FROM payments_old_0007;

DROP TABLE payments_old_0007;

CREATE INDEX idx_payments_customer_email_hash ON payments(customer_email_hash);

-- ---------- purchase_intents ----------
-- payments のRENAMEにより、foreign_keys=ON下ではSQLiteが自動的に
-- purchase_intents.payment_id の参照文字列を "payments_old_0007" へ
-- 書き換えてしまう（0005のコメントと同じ既知動作）。0005と同様、
-- purchase_intentsも再作成して参照を"payments"へ戻す。列構成・制約は
-- 0005が作った現行スキーマと完全に同一（変更なし）。
ALTER TABLE purchase_intents RENAME TO purchase_intents_old_0007;

CREATE TABLE purchase_intents (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_public_id      TEXT NOT NULL UNIQUE,
  plan_code             TEXT NOT NULL CHECK (plan_code IN ('single','pack10','pack30','pack50')),
  claim_token_hash      TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','fulfilled','expired')),
  payment_id            INTEGER REFERENCES payments(id),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fulfilled_at          TEXT,
  stripe_checkout_session_id  TEXT,
  access_token_hash     TEXT UNIQUE
);

INSERT INTO purchase_intents
  (id, intent_public_id, plan_code, claim_token_hash, status, payment_id,
   created_at, fulfilled_at, stripe_checkout_session_id, access_token_hash)
SELECT
   id, intent_public_id, plan_code, claim_token_hash, status, payment_id,
   created_at, fulfilled_at, stripe_checkout_session_id, access_token_hash
FROM purchase_intents_old_0007;

DROP TABLE purchase_intents_old_0007;

CREATE UNIQUE INDEX idx_purchase_intents_session_id ON purchase_intents(stripe_checkout_session_id);

-- ---------- purchase_entitlements ----------
-- anon_id列を追加する（無料entitlementにのみ設定。有料はNULLのまま）。
-- 「同一anon_idのactive行は同時に1つまで」を部分UNIQUEインデックスで強制する。
ALTER TABLE purchase_entitlements RENAME TO purchase_entitlements_old_0007;

CREATE TABLE purchase_entitlements (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_public_id  TEXT NOT NULL UNIQUE,
  payment_id             INTEGER UNIQUE REFERENCES payments(id),
  purchase_intent_id     INTEGER UNIQUE REFERENCES purchase_intents(id),
  allowed_predictions    INTEGER NOT NULL CHECK (allowed_predictions IN (1,10,30,50)),
  consumed_predictions   INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed')),
  claim_token_hash       TEXT NOT NULL UNIQUE,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  consumed_at            TEXT,
  -- FREE PUBLIC BETA用。無料entitlementの発行元anon_id（localStorage由来のUUID）。
  -- 有料entitlementはNULLのまま。
  anon_id                TEXT
);

INSERT INTO purchase_entitlements
  (id, entitlement_public_id, payment_id, purchase_intent_id, allowed_predictions,
   consumed_predictions, status, claim_token_hash, created_at, consumed_at)
SELECT
   id, entitlement_public_id, payment_id, purchase_intent_id, allowed_predictions,
   consumed_predictions, status, claim_token_hash, created_at, consumed_at
FROM purchase_entitlements_old_0007;

DROP TABLE purchase_entitlements_old_0007;

-- 「同一anon_idにつき、未消費(active)のentitlementは同時に1つまで」を
-- DB自身に保証させる部分UNIQUEインデックス（計画書1.2）。
-- 有料entitlement（anon_id IS NULL）は対象外。
CREATE UNIQUE INDEX idx_one_active_free_entitlement_per_anon
  ON purchase_entitlements(anon_id)
  WHERE status = 'active' AND anon_id IS NOT NULL;

-- ---------- predictions ----------
ALTER TABLE predictions RENAME TO predictions_old_0007;

CREATE TABLE predictions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id       TEXT NOT NULL UNIQUE,
  display_sequence    INTEGER NOT NULL UNIQUE,
  draw_number         TEXT NOT NULL,
  number_1            INTEGER NOT NULL,
  number_2            INTEGER NOT NULL,
  number_3            INTEGER NOT NULL,
  number_4            INTEGER NOT NULL,
  number_5            INTEGER NOT NULL,
  number_6            INTEGER NOT NULL,
  combination_key     TEXT NOT NULL UNIQUE,
  generated_at        TEXT NOT NULL,
  payment_id          INTEGER NOT NULL REFERENCES payments(id),
  entitlement_id      INTEGER NOT NULL REFERENCES purchase_entitlements(id),
  prediction_index    INTEGER NOT NULL,
  plan_code           TEXT NOT NULL CHECK (plan_code IN ('single','pack10','pack30','pack50','free')),
  algorithm_version   TEXT NOT NULL,
  previous_hash       TEXT NOT NULL UNIQUE,
  record_hash         TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (entitlement_id, prediction_index),
  CHECK (number_1 >= 1 AND number_6 <= 43),
  CHECK (number_1 < number_2 AND number_2 < number_3 AND number_3 < number_4
         AND number_4 < number_5 AND number_5 < number_6)
);

INSERT INTO predictions
  (id, prediction_id, display_sequence, draw_number,
   number_1, number_2, number_3, number_4, number_5, number_6,
   combination_key, generated_at, payment_id, entitlement_id,
   prediction_index, plan_code, algorithm_version, previous_hash, record_hash, created_at)
SELECT
   id, prediction_id, display_sequence, draw_number,
   number_1, number_2, number_3, number_4, number_5, number_6,
   combination_key, generated_at, payment_id, entitlement_id,
   prediction_index, plan_code, algorithm_version, previous_hash, record_hash, created_at
FROM predictions_old_0007;

DROP TABLE predictions_old_0007;

CREATE INDEX idx_predictions_entitlement ON predictions(entitlement_id);
CREATE INDEX idx_predictions_created_at ON predictions(created_at);
CREATE INDEX idx_predictions_payment ON predictions(payment_id);

-- immutabilityトリガーはテーブル再作成で失われるため必ず再作成する
-- （既存仕様：predictionsへのUPDATE/DELETEは常に禁止）。
CREATE TRIGGER trg_predictions_no_update BEFORE UPDATE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: UPDATE is forbidden'); END;
CREATE TRIGGER trg_predictions_no_delete BEFORE DELETE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: DELETE is forbidden'); END;

-- ---------- predictions を参照している4テーブルのFKを "predictions" に貼り直す ----------
-- 【重要】0005と同じSQLite既知動作（RENAME時にFK宣言が書き換わる）への対処。
-- 列構成・CHECK・UNIQUE・インデックス・トリガーは既存のものと完全に同一にする。

ALTER TABLE prediction_results RENAME TO prediction_results_old_0007;
CREATE TABLE prediction_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id       TEXT NOT NULL UNIQUE REFERENCES predictions(prediction_id),
  winning_number_1    INTEGER NOT NULL,
  winning_number_2    INTEGER NOT NULL,
  winning_number_3    INTEGER NOT NULL,
  winning_number_4    INTEGER NOT NULL,
  winning_number_5    INTEGER NOT NULL,
  winning_number_6    INTEGER NOT NULL,
  bonus_number        INTEGER,
  matched_numbers     TEXT NOT NULL,
  match_count         INTEGER NOT NULL,
  prize_rank          TEXT,
  result_source       TEXT NOT NULL,
  verified_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO prediction_results SELECT * FROM prediction_results_old_0007;
DROP TABLE prediction_results_old_0007;

ALTER TABLE prediction_matches RENAME TO prediction_matches_old_0007;
CREATE TABLE prediction_matches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  prediction_id     TEXT NOT NULL REFERENCES predictions(prediction_id),
  draw_id           TEXT NOT NULL REFERENCES lottery_draws(draw_id),
  tracking_type     TEXT NOT NULL CHECK(tracking_type IN ('historical_backtest','forward_tracking')),
  main_match_count  INTEGER NOT NULL CHECK(main_match_count BETWEEN 0 AND 6),
  bonus_match       INTEGER NOT NULL CHECK(bonus_match IN (0,1)),
  equivalent_rank   TEXT CHECK(equivalent_rank IN ('1','2','3','4','5') OR equivalent_rank IS NULL),
  elapsed_days      INTEGER,
  elapsed_draws     INTEGER,
  checked_at        TEXT NOT NULL,
  UNIQUE(prediction_id,draw_id)
);
INSERT INTO prediction_matches SELECT * FROM prediction_matches_old_0007;
DROP TABLE prediction_matches_old_0007;
CREATE INDEX idx_prediction_matches_prediction ON prediction_matches(prediction_id,tracking_type);
CREATE INDEX idx_prediction_matches_draw ON prediction_matches(draw_id);
CREATE TRIGGER trg_prediction_matches_no_update BEFORE UPDATE ON prediction_matches BEGIN SELECT RAISE(ABORT,'prediction_matches are immutable'); END;
CREATE TRIGGER trg_prediction_matches_no_delete BEFORE DELETE ON prediction_matches BEGIN SELECT RAISE(ABORT,'prediction_matches are immutable'); END;

ALTER TABLE prediction_tracking_summary RENAME TO prediction_tracking_summary_old_0007;
CREATE TABLE prediction_tracking_summary (
  prediction_id         TEXT PRIMARY KEY REFERENCES predictions(prediction_id),
  checked_draw_count    INTEGER NOT NULL DEFAULT 0,
  best_main_match_count INTEGER NOT NULL DEFAULT 0,
  best_bonus_match      INTEGER NOT NULL DEFAULT 0,
  best_equivalent_rank  TEXT,
  best_draw_id          TEXT REFERENCES lottery_draws(draw_id),
  days_to_best          INTEGER,
  draws_to_best         INTEGER,
  first_3plus_draw_id   TEXT REFERENCES lottery_draws(draw_id),
  updated_at            TEXT NOT NULL
);
INSERT INTO prediction_tracking_summary SELECT * FROM prediction_tracking_summary_old_0007;
DROP TABLE prediction_tracking_summary_old_0007;

ALTER TABLE prediction_generation_features RENAME TO prediction_generation_features_old_0007;
CREATE TABLE prediction_generation_features (
  prediction_id  TEXT PRIMARY KEY REFERENCES predictions(prediction_id),
  features_json  TEXT NOT NULL,
  captured_at    TEXT NOT NULL
);
INSERT INTO prediction_generation_features SELECT * FROM prediction_generation_features_old_0007;
DROP TABLE prediction_generation_features_old_0007;

PRAGMA foreign_keys=ON;

-- ============================================================
-- FREE PUBLIC BETA 新規テーブル
-- ============================================================

-- 24時間制限の原子的ゲート（計画書1.3）。
-- last_success_at は「claimが実際に成功した時刻」のみを保持する
-- （entitlement発行時刻ではない）。BEFORE UPDATEトリガーにより、
-- 直近の成功から24時間(=1.0日)未満での更新はABORTされ、batch全体が
-- ロールバックされる（＝24時間枠が誤って消費されることはない）。
CREATE TABLE free_generation_locks (
  anon_id            TEXT PRIMARY KEY,
  last_success_at    TEXT NOT NULL
);

CREATE TRIGGER trg_free_lock_24h
BEFORE UPDATE ON free_generation_locks
WHEN julianday(NEW.last_success_at) - julianday(OLD.last_success_at) < 1.0
BEGIN
  SELECT RAISE(ABORT, 'free_generation: 24h window not yet elapsed');
END;

-- 無料生成の実績ログ（追記専用・分析用）。
-- 継続生成ユーザー数・累計生成数等の集計にそのまま使う。
-- claim成功時にのみ1行追記する（entitlement発行時ではない）。
CREATE TABLE free_generation_log (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_id                TEXT NOT NULL,
  payment_public_id      TEXT NOT NULL,
  entitlement_public_id  TEXT NOT NULL,
  generated_at           TEXT NOT NULL
);
CREATE INDEX idx_free_generation_log_anon ON free_generation_log(anon_id, generated_at);

CREATE TRIGGER trg_free_generation_log_no_update BEFORE UPDATE ON free_generation_log BEGIN SELECT RAISE(ABORT,'free_generation_log is immutable'); END;
CREATE TRIGGER trg_free_generation_log_no_delete BEFORE DELETE ON free_generation_log BEGIN SELECT RAISE(ABORT,'free_generation_log is immutable'); END;
