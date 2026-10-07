-- ============================================================
-- STEP 4: 端末変更・localStorage消失時の購入履歴復旧
--
-- 「購入者は予測をずっと見られる」を、access_tokenのlocalStorage保持
-- だけに依存させないための追加。Stripe Checkoutが収集したメール
-- アドレスを鍵に、D1を正本として「もう一度自分の全購入の
-- access_tokenを再発行してもらう」ためのワンタイム・短命な
-- 復旧トークンの仕組みを追加する。
--
-- 安全性の設計：
--   ・生のメールアドレスはDBに保存しない。HMAC-SHA256でハッシュ化した
--     customer_email_hashのみを保存する（claim_token_hash等と同じ方式。
--     秘密鍵はenv.EMAIL_HASH_SECRET＝Cloudflare Worker Secretとして
--     人間が設定する）。
--   ・復旧リンクのrecovery_tokenは平文をメール本文にのみ一度だけ載せ、
--     DBにはハッシュのみ保存する。短命（有効期限あり）・単回使用
--     （使用後used_atを記録し、以後は無効）。
--   ・「そのメールアドレス宛の購入が存在するか」で応答を変えない
--     （enumeration対策。アプリ側で常に同じ200応答を返す）。
--   ・既存のpayments/predictions等の列・制約・トリガーには一切触れない
--     （追加のみ）。
-- ============================================================

ALTER TABLE payments ADD COLUMN customer_email_hash TEXT;
CREATE INDEX idx_payments_customer_email_hash ON payments(customer_email_hash);

CREATE TABLE recovery_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  recovery_token_hash   TEXT NOT NULL UNIQUE,
  customer_email_hash   TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at            TEXT NOT NULL,
  used_at               TEXT
);
CREATE INDEX idx_recovery_requests_email_hash ON recovery_requests(customer_email_hash);
