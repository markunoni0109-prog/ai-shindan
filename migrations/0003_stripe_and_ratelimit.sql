-- ============================================================
-- STEP 2B/2C: Stripe連携・レート制限用の追加スキーマ
-- ============================================================

-- successページがWebhook到達前でも「どの購入か」を引けるように、
-- Checkout Session作成直後（Stripeへの作成呼び出し成功時点）に
-- stripe_checkout_session_idを記録する。
-- （SQLiteの制約上、ALTER TABLE ADD COLUMNにUNIQUEを直接付けられないため、
--   列追加後にUNIQUE INDEXを別途作成する。NULL同士は重複とみなされない
--   ため、まだセッション未作成のpending行が複数あっても問題ない）
ALTER TABLE purchase_intents ADD COLUMN stripe_checkout_session_id TEXT;
CREATE UNIQUE INDEX idx_purchase_intents_session_id ON purchase_intents(stripe_checkout_session_id);

-- claim / checkout エンドポイントへのレート制限用。
-- 固定ウィンドウ方式の簡易カウンタ（本番はCloudflare Rate Limiting Rules
-- 等の基盤側対策と併用することを推奨。README参照）。
CREATE TABLE rate_limit_buckets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_key    TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bucket_key, window_start)
);
