# LOTO6 NEXUS 最終GitHub公開候補 監査報告

## 正式商品
- 1予測 = 300円
- plan_code: `single`
- allowed_predictions: `1`
- Stripe Checkout金額: 300 JPY（サーバー固定）
- Webhook entitlement: 1予測

## Permanent Tracking整合
- 特定回を予測対象として固定しない。
- 互換フィールド `draw_number` は新規生成時 `PERMANENT_TRACKING` を保存。
- prediction_id / 6数字 / generated_at / algorithm_version / hash chain は維持。
- Historical Backtest と Forward Tracking は分離。

## SEO公開ページ
- `/loto6/predictions/` 公開予測履歴
- `/loto6/tracking/` Permanent Tracking説明
- `/loto6/data/` 研究データ
- `/loto6/ai/` AI予測・生成方法
- `/loto6/faq/` FAQ
- 上記ページは相互内部リンク済み。canonical / title / description / H1を設定。
- 実績値の仮値掲載なし。dataページは公開APIの実データを取得。

## 監査
- 自動テスト: 64/64 PASS
- migration SQL: 0001〜0004を空SQLite DBへ順次適用 PASS
- JS syntax: src + frontend-additions 全PASS
- 旧商品文字列（5口/5通り/1000円/plan five）: 0件（package-lock除外）
- CURRENT_DRAW_NUMBER / TBD: 0件
- READMEのIdempotency-Key未実装記述: 削除済み
- Stripe Idempotency-Key: 実装済み
- 実Secrets: 0件。テスト用 `sk_test_mock_*` / `whsec_test_mock_*` のみ。

## GitHub投入時の注意
- `frontend-additions/loto6/` は既存 `/loto6/` へ追加配置する公開差分。
- TOILET SOSルートファイルは本ZIPに含めず、削除・上書きしない。
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / D1 ID等の実値はGitHubへ入れない。
- remote D1 / Stripe実環境の設定と実接続確認は本番環境工程で行う。
