-- ============================================================
-- AI HUNTER LOTO6 — STEP 2A schema (D1 / SQLite)
-- v1.1 FINAL準拠。STEP 2Aでは payments/purchase_intents は
-- Stripe未接続のためスキーマのみ用意し、実際の運用（Webhookからの
-- 書き込み）はSTEP 2Cで接続する。
-- ============================================================

CREATE TABLE payments (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_public_id           TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  plan_code                   TEXT NOT NULL CHECK (plan_code IN ('single')),
  amount                      INTEGER NOT NULL,
  currency                    TEXT NOT NULL DEFAULT 'jpy' CHECK (currency = 'jpy'),
  payment_status              TEXT NOT NULL DEFAULT 'pending'
                               CHECK (payment_status IN ('pending','paid','failed')),
  paid_at                     TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stripe_event_id             TEXT UNIQUE
);

-- Checkout Session作成段階でclaim_tokenを発行するためのテーブル（v1.1 FINAL追加）。
-- Stripe決済が確定するとpayment_idが紐づき、statusがfulfilledになる想定。
CREATE TABLE purchase_intents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_public_id  TEXT NOT NULL UNIQUE,
  plan_code         TEXT NOT NULL CHECK (plan_code IN ('single')),
  claim_token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256(token)のみ。平文は保存しない
  status            TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','fulfilled','expired')),
  payment_id        INTEGER REFERENCES payments(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fulfilled_at      TEXT
);

CREATE TABLE purchase_entitlements (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  entitlement_public_id  TEXT NOT NULL UNIQUE,
  payment_id             INTEGER UNIQUE REFERENCES payments(id),
  purchase_intent_id     INTEGER UNIQUE REFERENCES purchase_intents(id),
  allowed_predictions    INTEGER NOT NULL CHECK (allowed_predictions = 1),
  consumed_predictions   INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed')),
  claim_token_hash       TEXT NOT NULL UNIQUE,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  consumed_at            TEXT
);

CREATE TABLE predictions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,          -- 内部ID（外部非公開）
  prediction_id       TEXT NOT NULL UNIQUE,                       -- 信用ID＝Worker生成UUID
  display_sequence    INTEGER NOT NULL UNIQUE,                    -- 表示用 #000001 の元番号
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
  plan_code           TEXT NOT NULL CHECK (plan_code IN ('single')),
  algorithm_version   TEXT NOT NULL,
  previous_hash       TEXT NOT NULL UNIQUE,
  record_hash         TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (entitlement_id, prediction_index),
  CHECK (number_1 >= 1 AND number_6 <= 43),
  CHECK (number_1 < number_2 AND number_2 < number_3 AND number_3 < number_4
         AND number_4 < number_5 AND number_5 < number_6)
);

CREATE INDEX idx_predictions_entitlement ON predictions(entitlement_id);
CREATE INDEX idx_predictions_created_at ON predictions(created_at);

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
  matched_numbers     TEXT NOT NULL,   -- JSON配列文字列。サーバー計算のみ
  match_count         INTEGER NOT NULL,
  prize_rank          TEXT,
  result_source       TEXT NOT NULL,
  verified_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE integrity_checkpoints (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_date          TEXT NOT NULL UNIQUE,
  last_prediction_id       TEXT,
  prediction_count         INTEGER NOT NULL,
  last_record_hash         TEXT,
  checkpoint_hash          TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  external_publish_status  TEXT NOT NULL DEFAULT 'pending',
  external_reference       TEXT
);
