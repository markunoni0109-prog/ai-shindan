# AI HUNTER LOTO6 — STEP 2B/2C 実装物 README

商品は1種類のみ：LOTO6 AI PREDICTION 1予測＝300円。

## 1. セットアップ
Node.js 22.5以上必須（`node:sqlite`使用）。
```bash
npm ci
npx wrangler d1 migrations apply ai_hunter_loto6 --local   # ローカルD1にスキーマ適用
npm test                                                    # 自動テスト（51件）
```
本番デプロイには別途 `wrangler secret put STRIPE_SECRET_KEY` 等が必要（§12参照）。

## 2. Stripe実装ファイル
- `src/lib/stripe.js`：Checkout Session作成（REST APIを直接fetch。SDK未使用）、Webhook署名検証（HMAC-SHA256を手動実装、SDK非依存）
- `src/lib/webhook.js`：署名検証後のイベント処理本体（payment/entitlementの冪等な作成）
- `src/lib/ratelimit.js`：D1ベースの簡易レート制限
- `src/lib/cors.js`：Origin許可リスト方式のCORS

Stripe公式SDKは使わず、Cloudflare Workers環境での動作実績が確実なfetch直叩き＋Web Crypto実装にした（依存を増やしたくないため）。

## 3. Worker API一覧
| Method | Path | 内容 |
|---|---|---|
| POST | /api/checkout/create | purchase_intent作成＋実際のStripe Checkout Session作成。claim_tokenを1度だけ返す |
| POST | /api/stripe/webhook | Stripe Webhook受信。署名検証必須 |
| GET | /api/purchases/status?session_id=... | pending/ready/failedのみ返す（秘密情報なし） |
| POST | /api/predictions/claim | STEP 2A実装を再利用。claim_token(body)→1予測返却。冪等 |
| GET | /api/history, /api/history/:id, /api/stats | STEP 2Aから変更なし |

CORS：`ALLOWED_ORIGINS`（wrangler.toml [vars]）に含まれるOriginのみ許可。OPTIONSプリフライトに対応。
レート制限：`/api/checkout/create` 10回/分/IP、`/api/predictions/claim` 20回/分/IP（README§9参照）。

## 4. DB変更・migration
- `migrations/0003_stripe_and_ratelimit.sql`
  - `purchase_intents.stripe_checkout_session_id`列を追加（UNIQUE INDEXで一意性を担保。SQLiteの制約上ALTER TABLEで直接UNIQUE列は追加できないため）
  - `rate_limit_buckets`テーブルを新設
- 0001/0002（STEP 2A）はそのまま。3ファイル合計を`wrangler d1 migrations apply --local`で適用し、実機（ローカルD1）で成功を確認済み。

## 5. フロント接続内容
Phase 1の既存ファイル（`loto6/index.html`, `loto6/css/style.css`, `loto6/js/*.js`, `loto6/history/*`）は**1バイトも変更していない**（本メッセージ内でmd5sumによる変更前後比較を提示）。

新規追加（`frontend-additions/loto6/` 以下、実際は `ai-hunter.jp/loto6/` 配下に配置想定）：
- `buy/index.html` + `buy.js`：「購入して1予測を生成する」ボタン。`POST /api/checkout/create`→Stripe Checkoutへリダイレクト
- `result/index.html` + `result.js`：success遷移後のページ。`GET /api/purchases/status`をpollしてreadyを確認→`POST /api/predictions/claim`→**Phase 1と同一タイミング**（1〜5球目0.4秒間隔、5→6球目のみ1.0秒）の6球演出を1予測ぶん順番に再生
- `js/api-config.js`：Worker APIのURLを指す新規設定ファイル（人間が実URLに置き換える）

claim_tokenは`success_url`のURLフラグメント（`#claim=...`）で受け渡し、サーバーログ・Referer等に残らない設計。サーバー保存成功前（claim成功前）に数字を演出表示しない設計を維持。

【未実施・既知の制約】新規ページのブラウザ実機QA（複数画面幅での目視確認等）は今回未実施。Worker実URLをデプロイした後、STEP 1で行ったのと同様のブラウザ実機QAを推奨する。

## 6〜10. テスト結果
`npm ci` → `npm test` で **51/51 PASS**（5回連続再現確認済み。実行ログは提出メッセージ本文に記載）。

内訳：
- STEP 2A由来（回帰確認）：engine 5／claim統合10／trigger 4 → 変更なく全pass
- 新規：checkout/claim/history/statusのHTTPテスト15、Stripe Webhook専用テスト9、Stripe library単体6、CORS/レート制限6

**Stripe系テスト結果（要求項目との対応）**
| # | 要求項目 | 対応テスト | 結果 |
|---|---|---|---|
| 1 | Checkout Session正常作成 | api.test.js | ✅ |
| 2 | 金額300円がサーバー固定 | stripe_lib.test.js | ✅ |
| 3 | クライアント金額改ざん無効 | api.test.js | ✅ |
| 4 | claim_token DB平文保存なし | claim.test.js(STEP2A)＋設計（claim_token_hashのみ保存） | ✅ |
| 5 | Webhook署名不正拒否 | stripe_webhook.test.js | ✅ |
| 6 | paid前entitlement発行なし | api.test.js「決済確認前はclaimできない」 | ✅ |
| 7 | paid後entitlement1件 | stripe_webhook.test.js | ✅ |
| 8 | Webhook同一event 2回→1件 | stripe_webhook.test.js | ✅ |
| 9 | Checkout Session重複→1 payment | stripe_webhook.test.js（異なるevent_id・同一session_id） | ✅ |
| 10 | entitlement重複なし | 同上 | ✅ |
| 11 | success先着→pending | api.test.js「purchases/status: 存在しないsession_idはpending」 | ✅ |
| 12 | Webhook後→ready | api.test.js | ✅ |
| 13 | ready後claim→1予測 | api.test.js | ✅ |
| 14 | claim再送→同じ1予測 | api.test.js／claim.test.js | ✅ |
| 15 | Stripe IDが公開履歴へ出ない | 全テストのassertNoSecrets | ✅ |
| 16 | claim_token/hashが公開履歴へ出ない | 同上 | ✅ |
| 17 | CORS拒否 | cors_ratelimit.test.js | ✅ |
| 18 | rate limit動作 | cors_ratelimit.test.js | ✅ |
| 19 | Worker例外時に秘密情報を返さない | 全体・stripe_lib.test.js（Stripeエラー詳細非漏洩） | ✅ |

**success先着テスト**：`purchases/status`は`purchase_intents`テーブルの`status`列のみを見て判定し、Webhook到達前は常に`pending`（該当session_id自体が未登録の場合も`pending`）。テストで直接確認済み。

**Webhook重複テスト**：同一`event.id`の再送、同一`stripe_checkout_session_id`に対する異なる`event.id`（Stripeの重複配信）、および2リクエストの真の同時到達（`Promise.all`）の3パターンすべてでpayment・entitlementが1件のみになることを確認。

**claim→1予測生成結果**：webhook経由でentitlement発行→claim→1予測取得→再送で同じ1予測、を一気通貫でテスト済み（STEP 2Aのhash chain・原子性ロジックをそのまま再利用しているため、combination_key重複防止・previous_hash連結等の保証はSTEP 2A同様に有効）。

## 11. Secrets名一覧（値は含めない）
| Secret名 | 用途 | 設定方法 |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe API呼び出し（Checkout Session作成） | `wrangler secret put STRIPE_SECRET_KEY` |
| `STRIPE_WEBHOOK_SECRET` | Webhook署名検証 | `wrangler secret put STRIPE_WEBHOOK_SECRET` |

`wrangler.toml`の`[vars]`にはSecretではない設定のみ記載（`FRONTEND_BASE_URL`, `ALLOWED_ORIGINS`）。コード・migration・テストのいずれにも実際の鍵の値は一切含まれていない（テストは`sk_test_mock_...`という明らかなダミー文字列のみ使用）。

## 12. Cloudflareで人間が設定する項目
1. `wrangler d1 create ai_hunter_loto6` を実行し、`wrangler.toml`の`database_id`を実IDに置き換える
2. `wrangler secret put STRIPE_SECRET_KEY` / `wrangler secret put STRIPE_WEBHOOK_SECRET`
3. `wrangler.toml [vars]`の`FRONTEND_BASE_URL`・`ALLOWED_ORIGINS`を実ドメインに更新
4. Worker本番デプロイ（`wrangler deploy`）とカスタムドメイン割り当て
5. （推奨）Cloudflare Rate Limiting Rules をダッシュボードで設定し、アプリ層のレート制限（本実装）と二重の防御にする
6. `frontend-additions/loto6/js/api-config.js`の`BASE_URL`を、実際にデプロイしたWorkerのURL/ドメインに書き換えてから`ai-hunter.jp/loto6/`へ配置

## 13. Stripeで人間が設定する項目
1. Stripeダッシュボードで本番/テスト両方のAPIキーを発行し、上記Secretsとして登録
2. Webhookエンドポイント（`https://<Worker URL>/api/stripe/webhook`）を登録し、`checkout.session.completed`イベントを購読
3. Webhook署名シークレット（`whsec_...`）を`STRIPE_WEBHOOK_SECRET`として登録
4. 決済手段はカード（即時決済）のみ有効化。コンビニ払い・銀行振込等の非同期決済は今回のCheckout Session作成時に含めていないため、Stripeダッシュボード側でも有効化しないこと

## 14. 既知の問題
1. **remote D1・実Stripe環境での最終検証は未実施**：Cloudflareアカウント・Stripeアカウントを持たないため、すべてローカル（wrangler d1 --local、Stripeはモックfetch＋本物の署名検証ロジック）で検証している。本番投入前に、実際のStripeテストモードでの決済〜Webhook到達までのエンドツーエンド確認を推奨する。
2. **フロント新規ページの実機ブラウザQA未実施**：`buy/`・`result/`ページのレイアウト・演出を複数画面幅で目視確認していない。Worker実URLデプロイ後に確認することを推奨する。
3. **レート制限はアプリ層のみ**：D1ベースの簡易実装（固定ウィンドウ、多少の誤差あり）。本番はCloudflare Rate Limiting Rulesとの併用を推奨（§12に記載）。
4. **非同期決済（コンビニ払い等）は未対応**：今回の指示どおり対象外。`payment_status !== 'paid'`のイベントはentitlementを発行せず無視する設計にしている。
6. **success_urlのfragmentにclaim_tokenを平文で埋め込む設計**：URLフラグメントはサーバーへ送信されないためアクセスログ等には残らないが、ブラウザ履歴には残る。この点はPhase 2技術監査報告で指摘済みのリスクと同種であり、許容範囲内と判断しているが記録として明記する。

## Phase 1凍結部分について
`loto6/index.html`・`loto6/css/style.css`・`loto6/js/{app,config,engine,history,storage}.js`・`loto6/history/index.html`は**今回一切変更していない**。変更前後のmd5sumが完全一致することを確認済み（提出メッセージ本文に記載）。

# Permanent Tracking v1 — 2026-09-20

## 追加実装
- `migrations/0004_permanent_tracking.sql`: lottery_draws / prediction_matches / prediction_tracking_summary / prediction_generation_features。draw/matchはUPDATE/DELETE禁止トリガー。
- `src/lib/tracking.js`: historical/forward分離、0〜6一致、bonus、等級相当、elapsed、best/first3+、summary再構築、全母集団統計、生成時特徴量。
- API: `GET /api/tracking`, `GET /api/tracking/:prediction_id`, `GET /api/research/stats`, `POST /api/admin/draws`。
- `POST /api/admin/draws` は `DRAW_INGEST_SECRET` のBearer認証必須。Secret値はリポジトリに含めない。
- `frontend-additions/loto6/predictions/`: prediction_id＋6数字主体の永久追跡UI。historicalは別枠表示。
- Stripe Checkoutに `Idempotency-Key: loto6-checkout-{intent_public_id}` を追加。

## 等級相当ルール
宝くじ公式サイトの現行ロト6当せん条件に合わせる：6本数字=1等、5本数字+B=2等、5本数字=3等、4本数字=4等、3本数字=5等。ボーナスは2等判定だけに使用。
参照: https://www.takarakuji-official.jp/ec/loto6/?kujiprdShbt=62

## 時間境界
`lottery_draws` の最低仕様が日付単位 `draw_date` のため、生成日と抽せん日が同日のケースは、未来実績を過大表示しないよう保守的に `historical_backtest` とする。将来、公式の抽せん確定時刻を信頼できる形で保持する場合は日時境界へ拡張可能。

## テスト
`npm test`: 64/64 PASS（既存Stripe/claim/hash/immutability回帰を含む）。公式実データQAとして、みずほ銀行公開の第1回（2000-10-05: 02,08,10,13,27,30 / B39）をfixtureに使用し、historical分類と一致数を確認。
参照: https://www.mizuhobank.co.jp/takarakuji/check/loto/backnumber/loto60001.html

## 本番前に必要
- remote Cloudflare D1で0001〜0004 migration適用確認
- `DRAW_INGEST_SECRET` をCloudflare Secretとして設定
- 公式抽せんデータの初期投入（出典URL付き）と件数監査
- 実ブラウザQA / Stripe Test Mode実接続QA
- AI HUNTER総合トップの最終GO

## 現行正式商品仕様（2026-09-20）
- 商品：LOTO6 AI PREDICTION **1予測 = 300円**のみ。
- plan_code: `single` / allowed_predictions: `1`。
- 予測は特定回向けの使い捨てではなく、`draw_number`互換フィールドには `PERMANENT_TRACKING` を保存し、prediction_idを主体に永久追跡する。
- Stripe Checkoutには `Idempotency-Key: loto6-checkout-{intent_public_id}` を実装済み。
- SEO役割：`/predictions/`=公開予測記録、`/tracking/`=Permanent Tracking説明、`/data/`=研究データ、`/ai/`=AI生成方法、`/faq/`=FAQ。
