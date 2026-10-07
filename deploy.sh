#!/usr/bin/env bash
# 本番Worker(ai-shindan)＋本番D1への反映。人間がローカルで実行する（実IDはGitHubへ入れない）。
#   使い方:  CF_D1_ID=<wrangler d1 list で確認した本番D1のID> bash scripts/deploy.sh
# 事前: `npx wrangler login`（または CLOUDFLARE_API_TOKEN を環境変数で）。Secretsは別途 wrangler secret put。
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CF_D1_ID:?CF_D1_ID（本番D1のID）を環境変数で指定してください}"
CFG=wrangler.deploy.toml
sed "s/REPLACE_WITH_REMOTE_D1_ID/${CF_D1_ID}/" wrangler.toml > "$CFG"
trap 'rm -f "$CFG"' EXIT
grep -q "^name = \"ai-shindan\"" "$CFG" || { echo "wrangler.tomlのnameがai-shindanではありません"; exit 1; }

echo "== 0) 適用前の読み取り専用監査（結果を保存して適用後と比較）"
bash scripts/prod-audit.sh | tee "prod-audit-before-$(date +%Y%m%d-%H%M%S).log"
echo "== 1) 本番D1: migration適用状況"
npx wrangler d1 migrations list ai_hunter_loto6 --remote -c "$CFG"
echo "上の監査で A2_partial_leftover_count=0 / E系=0 / foreign_key_check が空 であることを確認してから進めてください。"
read -r -p "未適用migration(0007/0008)を本番D1へ適用し、Workerをデプロイしますか？ [y/N] " ans
[ "$ans" = "y" ] || { echo "中止しました"; exit 1; }
npx wrangler d1 migrations apply ai_hunter_loto6 --remote -c "$CFG"
echo "== 2) 適用後の読み取り専用監査（適用前と C_/D_ 系が一致すること）"
bash scripts/prod-audit.sh | tee "prod-audit-after-$(date +%Y%m%d-%H%M%S).log"
read -r -p "監査結果に問題が無ければWorkerをデプロイします。続行しますか？ [y/N] " ans2
[ "$ans2" = "y" ] || { echo "デプロイは行いませんでした（migrationは適用済み）"; exit 1; }
echo "== 3) Workerデプロイ"
npx wrangler deploy -c "$CFG"
echo "== 4) 反映確認"
bash scripts/verify-prod.sh
