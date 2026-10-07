#!/usr/bin/env bash
# 本番D1の読み取り専用監査（SELECT と PRAGMA foreign_key_check のみ。書き込みは一切しない）。
# migration 0007/0008 の「適用前」と「適用後」に実行し、出力を比較する。
#   使い方:  CF_D1_ID=<本番D1のID> bash scripts/prod-audit.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CF_D1_ID:?CF_D1_ID（本番D1のID）を環境変数で指定してください}"
CFG=wrangler.audit.toml
sed "s/REPLACE_WITH_REMOTE_D1_ID/${CF_D1_ID}/" wrangler.toml > "$CFG"
trap 'rm -f "$CFG"' EXIT
echo "== 1) 監査クエリ（check_name / value / expected）"
npx wrangler d1 execute ai_hunter_loto6 --remote -c "$CFG" --command "$(cat scripts/prod-audit.sql)"
echo "== 2) 外部キー整合チェック（結果が空＝違反なし）"
npx wrangler d1 execute ai_hunter_loto6 --remote -c "$CFG" --command "PRAGMA foreign_key_check;"
