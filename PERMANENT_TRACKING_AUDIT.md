# LOTO6 NEXUS Permanent Tracking 実装監査

基準: step2bc.zipを展開し、既存predictions/hash/Stripe/entitlement/claimを維持したまま拡張。

## 実装
- 原本 predictions は無変更・既存immutability trigger維持。
- 証拠: prediction_matches。`UNIQUE(prediction_id, draw_id)`で冪等。
- 抽せん原本: lottery_draws。UPDATE/DELETE禁止。
- summaryはforwardのみから再構築可能。
- historical/forwardをDB列で分離。
- 生成時特徴量をJSONで保存できるテーブルを追加。
- 公開統計は全predictionsを母集団にする。
- 永久追跡UIを `/loto6/predictions/` 用として追加。

## 検証
- 64/64 automated tests PASS。
- 0〜6一致、bonus、等級相当、境界、冪等、elapsed、best、first3+、summary再構築、historical混入防止、immutabilityを確認。
- 既存Stripe/claim/hash chainテストもPASS。
- Stripe Idempotency-Keyも追加テスト済み。

## 未完了（本番GO条件）
remote D1、実Stripe Test Mode、全公式抽せんデータ投入、実ブラウザQAは環境接続が必要なため未実施。本ZIPは公開候補のコード成果物であり、本番反映済みではない。

## Final product/SEO alignment (2026-09-20)
- Product: 1 prediction = JPY 300 (`single`, allowed_predictions=1).
- Prediction scope marker: `PERMANENT_TRACKING`; target draw placeholder removed.
- Stripe Checkout Idempotency-Key implemented.
- SEO pages: /predictions/, /tracking/, /data/, /ai/, /faq/ with canonical and internal navigation.
