-- ============================================================
-- STEP 3: まとめ買い（10/30/50予測）＋購入者専用「マイ予測」対応
--
-- SQLiteはCHECK制約を後からALTERできないため、対象4テーブル
-- （payments / purchase_intents / purchase_entitlements / predictions）
-- を「新テーブル作成→データコピー（idを保持）→旧テーブル破棄」の
-- 手順で再構築する。既存データ（実際の決済・予測履歴）は一切失われない
-- ことを、この手順（idを明示的に指定してコピー）で担保する。
--
-- 変更点はCHECK制約の許容値拡張と、マイ予測用の access_token_hash
-- 列の追加のみ。列構成・UNIQUE制約・トリガー・インデックスは
-- 既存のものをすべてそのまま引き継ぐ（immutabilityトリガーも再作成する）。
--
-- 【本番適用時の注意】このファイルはCloudflare D1へ
--   wrangler d1 migrations apply <DB> --remote
-- で適用すること。適用後、必ず remote 環境で
--   - predictions への UPDATE/DELETE がABORTされること
--   - 既存の決済・予測件数が変わっていないこと（SELECT COUNT(*)）
-- を実機で再確認すること（migrations/0002のコメント参照）。
-- ============================================================

PRAGMA foreign_keys=OFF;

-- ---------- payments ----------
ALTER TABLE payments RENAME TO payments_old_0005;

CREATE TABLE payments (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_public_id           TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  plan_code                   TEXT NOT NULL CHECK (plan_code IN ('single','pack10','pack30','pack50')),
  amount                      INTEGER NOT NULL,
  currency                    TEXT NOT NULL DEFAULT 'jpy' CHECK (currency = 'jpy'),
  payment_status              TEXT NOT NULL DEFAULT 'pending'
                               CHECK (payment_status IN ('pending','paid','failed')),
  paid_at                     TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stripe_event_id             TEXT UNIQUE,
  -- マイ予測（購入者本人による再閲覧）用の再識別トークンのハッシュ。
  -- 平文はDBに保存しない（claim_token_hashと同じ方式）。NULL可＝旧行は
  -- マイ予測非対応のまま（後から見れなくても実害はない、閲覧専用のため）。
  access_token_hash           TEXT UNIQUE
);

INSERT INTO payments
  (id, payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
   plan_code, amount, currency, payment_status, paid_at, created_at, stripe_event_id)
SELECT
   id, payment_public_id, stripe_checkout_session_id, stripe_payment_intent_id,
   plan_code, amount, currency, payment_status, paid_at, created_at, stripe_event_id
FROM payments_old_0005;

DROP TABLE payments_old_0005;

-- ---------- purchase_intents ----------
ALTER TABLE purchase_intents RENAME TO purchase_intents_old_0005;

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
  -- claim_tokenと同時にCheckout Session作成時点で発行する、マイ予測用
  -- アクセストークンのハッシュ（平文はブラウザにのみ一度返す）。
  access_token_hash     TEXT UNIQUE
);

INSERT INTO purchase_intents
  (id, intent_public_id, plan_code, claim_token_hash, status, payment_id,
   created_at, fulfilled_at, stripe_checkout_session_id)
SELECT
   id, intent_public_id, plan_code, claim_token_hash, status, payment_id,
   created_at, fulfilled_at, stripe_checkout_session_id
FROM purchase_intents_old_0005;

DROP TABLE purchase_intents_old_0005;

CREATE UNIQUE INDEX idx_purchase_intents_session_id ON purchase_intents(stripe_checkout_session_id);

-- ---------- purchase_entitlements ----------
ALTER TABLE purchase_entitlements RENAME TO purchase_entitlements_old_0005;

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
  consumed_at            TEXT
);

INSERT INTO purchase_entitlements
  (id, entitlement_public_id, payment_id, purchase_intent_id, allowed_predictions,
   consumed_predictions, status, claim_token_hash, created_at, consumed_at)
SELECT
   id, entitlement_public_id, payment_id, purchase_intent_id, allowed_predictions,
   consumed_predictions, status, claim_token_hash, created_at, consumed_at
FROM purchase_entitlements_old_0005;

DROP TABLE purchase_entitlements_old_0005;

-- ---------- predictions ----------
ALTER TABLE predictions RENAME TO predictions_old_0005;

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
  plan_code           TEXT NOT NULL CHECK (plan_code IN ('single','pack10','pack30','pack50')),
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
FROM predictions_old_0005;

DROP TABLE predictions_old_0005;

CREATE INDEX idx_predictions_entitlement ON predictions(entitlement_id);
CREATE INDEX idx_predictions_created_at ON predictions(created_at);
-- マイ予測（購入単位で全予測を引く）用。
CREATE INDEX idx_predictions_payment ON predictions(payment_id);

-- immutabilityトリガーはテーブル再作成で失われるため必ず再作成する
-- （既存仕様：predictionsへのUPDATE/DELETEは常に禁止）。
CREATE TRIGGER trg_predictions_no_update BEFORE UPDATE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: UPDATE is forbidden'); END;
CREATE TRIGGER trg_predictions_no_delete BEFORE DELETE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: DELETE is forbidden'); END;

-- ---------- predictions を参照している4テーブルのFKを "predictions" に貼り直す ----------
-- 【重要】SQLiteは `ALTER TABLE predictions RENAME TO predictions_old_0005` を実行した際、
-- 他テーブルのFK宣言 `REFERENCES predictions(...)` を自動的に
-- `REFERENCES "predictions_old_0005"(...)` へ書き換えてしまう（SQLite公式の既知動作）。
-- その後predictions_old_0005をDROPしたため、prediction_results /
-- prediction_matches / prediction_tracking_summary / prediction_generation_features
-- の4テーブルは実在しないテーブルを参照する壊れたFK定義のままになっている。
-- ここで4テーブルとも作り直し、FK参照先を実在する"predictions"に戻す。
-- 列構成・CHECK・UNIQUE・インデックス・トリガーは既存のものと完全に同一にする
-- （データはid/主キーを保持してそのままコピーする）。

ALTER TABLE prediction_results RENAME TO prediction_results_old_0005;
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
INSERT INTO prediction_results SELECT * FROM prediction_results_old_0005;
DROP TABLE prediction_results_old_0005;

ALTER TABLE prediction_matches RENAME TO prediction_matches_old_0005;
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
INSERT INTO prediction_matches SELECT * FROM prediction_matches_old_0005;
DROP TABLE prediction_matches_old_0005;
CREATE INDEX idx_prediction_matches_prediction ON prediction_matches(prediction_id,tracking_type);
CREATE INDEX idx_prediction_matches_draw ON prediction_matches(draw_id);
CREATE TRIGGER trg_prediction_matches_no_update BEFORE UPDATE ON prediction_matches BEGIN SELECT RAISE(ABORT,'prediction_matches are immutable'); END;
CREATE TRIGGER trg_prediction_matches_no_delete BEFORE DELETE ON prediction_matches BEGIN SELECT RAISE(ABORT,'prediction_matches are immutable'); END;

ALTER TABLE prediction_tracking_summary RENAME TO prediction_tracking_summary_old_0005;
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
INSERT INTO prediction_tracking_summary SELECT * FROM prediction_tracking_summary_old_0005;
DROP TABLE prediction_tracking_summary_old_0005;

ALTER TABLE prediction_generation_features RENAME TO prediction_generation_features_old_0005;
CREATE TABLE prediction_generation_features (
  prediction_id  TEXT PRIMARY KEY REFERENCES predictions(prediction_id),
  features_json  TEXT NOT NULL,
  captured_at    TEXT NOT NULL
);
INSERT INTO prediction_generation_features SELECT * FROM prediction_generation_features_old_0005;
DROP TABLE prediction_generation_features_old_0005;

PRAGMA foreign_keys=ON;
