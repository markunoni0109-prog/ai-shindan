-- ============================================================
-- predictions テーブルの UPDATE / DELETE を禁止するトリガー。
--
-- 【重要な既知の注意点】
-- Cloudflare D1のマイグレーション機構（wrangler d1 migrations apply）は
-- 過去に、複数行にまたがる CREATE TRIGGER ... BEGIN ... END; 文を
-- SQL分割処理が壊してしまい、ローカルでは成功するのに本番(remote)側で
-- "incomplete input" エラーになる不具合が複数報告されている。
-- そのため本ファイルでは各トリガーを意図的に1行で記述している。
-- それでも本番D1へ適用する際は、必ず
--   wrangler d1 migrations apply <DB> --remote
-- 適用後に実機（ローカルではなくremote）でトリガーが実際に効くか
-- （UPDATE/DELETEがABORTされるか）を再確認すること。
-- ============================================================

CREATE TRIGGER trg_predictions_no_update BEFORE UPDATE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: UPDATE is forbidden'); END;

CREATE TRIGGER trg_predictions_no_delete BEFORE DELETE ON predictions BEGIN SELECT RAISE(ABORT, 'predictions are immutable: DELETE is forbidden'); END;
