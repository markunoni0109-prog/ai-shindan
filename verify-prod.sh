#!/usr/bin/env bash
# 本番Workerに FREE生成route が存在するかを副作用なしで確認する。
# 不正なanon_idを送る → route有り: 400 invalid_anon_id ／ route無し(旧Worker): 404 not_found
set -uo pipefail
BASE="${API_BASE:-https://ai-shindan.markun-oni0109.workers.dev}"
ORIGIN="${ORIGIN:-https://ai-hunter.jp}"
echo "POST $BASE/api/free/generate (anon_id=x: 不正値→何も作成されない)"
curl -sS -i -X POST "$BASE/api/free/generate" -H "content-type: application/json" -H "Origin: $ORIGIN" -d '{"anon_id":"x"}' | sed -n '1p;/^access-control-allow-origin/Ip;$p'
echo
echo "期待: HTTP 400 / access-control-allow-origin: $ORIGIN / {\"error\":{\"code\":\"invalid_anon_id\"..."
echo "404 not_found なら本番Workerは旧版（FREE route無し）です。"
