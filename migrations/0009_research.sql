-- ============================================================
-- 0009_research.sql — 研究用の自動予測・追跡（設計案 v3）
--
-- 【追加のみ】既存の表（payments / predictions / prediction_matches 等）には一切触れない。
-- 研究用データは research_* に完全に分離する（購入実績・売上・購入者数に混ざる経路は無い）。
--
-- 変更不可（UPDATE / DELETE 禁止）: research_batches / research_predictions /
--   research_commits / research_matches / research_draw_tallies
-- 更新できるのは、数字や結果を含まない管理用の research_jobs のみ。
--
-- 【D1の既知の注意】複数行にまたがる CREATE TRIGGER は、D1のSQL分割で壊れる不具合が
-- 報告されているため、各トリガーを意図的に1行で記述している（0002と同じ方針）。
-- 本番適用後は、実機でトリガーが効くこと（UPDATE/DELETEがABORTされること）を必ず確認する。
-- ============================================================

-- 抽せん日程（cronが次の抽せん日を判断する）。draw_at は抽せん開始日時（JST・通常18:45）
CREATE TABLE draw_schedule (
  draw_number INTEGER PRIMARY KEY,
  draw_date   TEXT NOT NULL,
  draw_at     TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 研究用の1回分（バッチ）
CREATE TABLE research_batches (
  batch_id            TEXT PRIMARY KEY,
  series              TEXT NOT NULL CHECK (series IN ('auto','pilot_manual')),
  target_draw_number  INTEGER NOT NULL,
  target_draw_date    TEXT NOT NULL,
  generated_at        TEXT NOT NULL,
  tickets_per_group   INTEGER NOT NULL CHECK (tickets_per_group > 0),
  seed_analysis       INTEGER,
  seed_control        INTEGER,
  rules_json          TEXT NOT NULL,
  prev_batch_hash     TEXT NOT NULL,
  evidence_level      TEXT NOT NULL CHECK (evidence_level IN ('server_recorded','file_hash_only')),
  source_file_sha256  TEXT,
  source_file_text    TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (series, target_draw_number)
);

-- 研究用の予測
CREATE TABLE research_predictions (
  research_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id           TEXT NOT NULL REFERENCES research_batches(batch_id),
  grp                TEXT NOT NULL CHECK (grp IN ('analysis','control')),
  ticket_no          INTEGER NOT NULL CHECK (ticket_no >= 1),
  number_1 INTEGER NOT NULL, number_2 INTEGER NOT NULL, number_3 INTEGER NOT NULL,
  number_4 INTEGER NOT NULL, number_5 INTEGER NOT NULL, number_6 INTEGER NOT NULL,
  combination_key    TEXT NOT NULL,
  algorithm_version  TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  previous_hash      TEXT NOT NULL,
  record_hash        TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (number_1 >= 1 AND number_6 <= 43),
  CHECK (number_1 < number_2 AND number_2 < number_3 AND number_3 < number_4 AND number_4 < number_5 AND number_5 < number_6),
  UNIQUE (batch_id, grp, ticket_no),
  UNIQUE (batch_id, grp, combination_key)
);
CREATE INDEX idx_rp_batch ON research_predictions(batch_id, grp);

-- 指紋（commit_hash）。全口の保存後に1回だけ書く
CREATE TABLE research_commits (
  batch_id     TEXT PRIMARY KEY REFERENCES research_batches(batch_id),
  commit_hash  TEXT NOT NULL UNIQUE,
  ticket_count INTEGER NOT NULL,
  committed_at TEXT NOT NULL
);

-- 1口ごとの照合結果（対象回は全口／長期追跡は3個以上一致の口のみ）
CREATE TABLE research_matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id      INTEGER NOT NULL REFERENCES research_predictions(research_id),
  draw_id          TEXT NOT NULL REFERENCES lottery_draws(draw_id),
  scope            TEXT NOT NULL CHECK (scope IN ('target','follow_up')),
  elapsed_days     INTEGER NOT NULL,
  tracking_type    TEXT NOT NULL CHECK (tracking_type IN ('forward_tracking','historical_backtest')),
  main_match_count INTEGER NOT NULL CHECK (main_match_count BETWEEN 0 AND 6),
  bonus_match      INTEGER NOT NULL CHECK (bonus_match IN (0,1)),
  equivalent_rank  TEXT CHECK (equivalent_rank IN ('1','2','3','4','5') OR equivalent_rank IS NULL),
  scored_at        TEXT NOT NULL,
  UNIQUE (research_id, draw_id)
);
CREATE INDEX idx_rm_draw ON research_matches(draw_id);
CREATE INDEX idx_rm_research ON research_matches(research_id);

-- 抽せんごと・バッチごと・群ごとの集計（対象回も長期追跡も、(バッチ,群,抽せん)につき1行）
CREATE TABLE research_draw_tallies (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id            TEXT NOT NULL REFERENCES research_batches(batch_id),
  grp                 TEXT NOT NULL CHECK (grp IN ('analysis','control')),
  draw_id             TEXT NOT NULL REFERENCES lottery_draws(draw_id),
  scope               TEXT NOT NULL CHECK (scope IN ('target','follow_up')),
  tracking_type       TEXT NOT NULL CHECK (tracking_type IN ('forward_tracking','historical_backtest')),
  target_draw_number  INTEGER NOT NULL,
  draw_number         INTEGER NOT NULL,
  draw_date           TEXT NOT NULL,
  generated_at        TEXT NOT NULL,
  elapsed_days        INTEGER NOT NULL,
  draws_after_target  INTEGER NOT NULL,
  tickets_checked     INTEGER NOT NULL,
  m0 INTEGER NOT NULL, m1 INTEGER NOT NULL, m2 INTEGER NOT NULL, m3 INTEGER NOT NULL,
  m4 INTEGER NOT NULL, m5 INTEGER NOT NULL, m5b INTEGER NOT NULL, m6 INTEGER NOT NULL,
  rank1 INTEGER NOT NULL, rank2 INTEGER NOT NULL, rank3 INTEGER NOT NULL, rank4 INTEGER NOT NULL, rank5 INTEGER NOT NULL,
  sum_main_match      INTEGER NOT NULL,
  scored_at           TEXT NOT NULL,
  UNIQUE (batch_id, grp, draw_id),
  CHECK (m0 + m1 + m2 + m3 + m4 + m5 + m5b + m6 = tickets_checked)
);
CREATE INDEX idx_rdt_draw ON research_draw_tallies(draw_id, scope);
CREATE INDEX idx_rdt_batch ON research_draw_tallies(batch_id, grp);

-- 進行管理（数字・結果は入れない。更新可能）
CREATE TABLE research_jobs (
  target_draw_number INTEGER PRIMARY KEY,
  step               TEXT NOT NULL CHECK (step IN ('planned','analysis_done','control_done','committed','scored','expired','failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  updated_at         TEXT NOT NULL
);

-- 再検証の記録（追記のみ。照合結果そのものではなく、検証の結果だけを残す）
CREATE TABLE research_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT NOT NULL,
  draw_id     TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('match','mismatch')),
  detail      TEXT,
  checked_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_pair ON research_audit_log(batch_id, draw_id, checked_at);

-- 変更不可の鍵（各1行）
CREATE TRIGGER trg_rb_no_update BEFORE UPDATE ON research_batches BEGIN SELECT RAISE(ABORT, 'research_batches are immutable'); END;
CREATE TRIGGER trg_rb_no_delete BEFORE DELETE ON research_batches BEGIN SELECT RAISE(ABORT, 'research_batches are immutable'); END;
CREATE TRIGGER trg_rp_no_update BEFORE UPDATE ON research_predictions BEGIN SELECT RAISE(ABORT, 'research_predictions are immutable'); END;
CREATE TRIGGER trg_rp_no_delete BEFORE DELETE ON research_predictions BEGIN SELECT RAISE(ABORT, 'research_predictions are immutable'); END;
CREATE TRIGGER trg_rc_no_update BEFORE UPDATE ON research_commits BEGIN SELECT RAISE(ABORT, 'research_commits are immutable'); END;
CREATE TRIGGER trg_rc_no_delete BEFORE DELETE ON research_commits BEGIN SELECT RAISE(ABORT, 'research_commits are immutable'); END;
CREATE TRIGGER trg_rm_no_update BEFORE UPDATE ON research_matches BEGIN SELECT RAISE(ABORT, 'research_matches are immutable'); END;
CREATE TRIGGER trg_rm_no_delete BEFORE DELETE ON research_matches BEGIN SELECT RAISE(ABORT, 'research_matches are immutable'); END;
CREATE TRIGGER trg_rdt_no_update BEFORE UPDATE ON research_draw_tallies BEGIN SELECT RAISE(ABORT, 'research_draw_tallies are immutable'); END;
CREATE TRIGGER trg_rdt_no_delete BEFORE DELETE ON research_draw_tallies BEGIN SELECT RAISE(ABORT, 'research_draw_tallies are immutable'); END;
CREATE TRIGGER trg_ral_no_update BEFORE UPDATE ON research_audit_log BEGIN SELECT RAISE(ABORT, 'research_audit_log is append-only'); END;
CREATE TRIGGER trg_ral_no_delete BEFORE DELETE ON research_audit_log BEGIN SELECT RAISE(ABORT, 'research_audit_log is append-only'); END;

-- 抽せん後は生成できない鍵：対象回の結果が既に lottery_draws にある場合、その回の研究用予測の追加を拒否する
CREATE TRIGGER trg_rp_no_postdraw BEFORE INSERT ON research_predictions BEGIN SELECT RAISE(ABORT, 'target draw already decided') WHERE EXISTS (SELECT 1 FROM research_batches b JOIN lottery_draws d ON d.draw_number = b.target_draw_number WHERE b.batch_id = NEW.batch_id); END;
