#!/usr/bin/env bash
set -euo pipefail

HOST_ALIAS="${1:-singsync-linode}"
API_URL="${2:-http://172.105.121.31:4000}"
QUERY="${3:-hello}"

echo "== Remote host =="
ssh "$HOST_ALIAS" 'whoami && hostname && pwd'

echo
echo "== PM2 status =="
ssh "$HOST_ALIAS" 'pm2 list'

echo
echo "== Server .env sanity (no secret output) =="
ssh "$HOST_ALIAS" "test -f /opt/singsync/server/.env && echo '.env exists' || (echo '.env missing' && exit 1)"
ssh "$HOST_ALIAS" "grep -q '^YOUTUBE_API_KEY=' /opt/singsync/server/.env && echo 'YOUTUBE_API_KEY line present' || (echo 'YOUTUBE_API_KEY line missing' && exit 1)"

echo
echo "== API /search check (expect NON-mock ids) =="
curl -sS "${API_URL}/api/search?q=$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote('''$QUERY'''))
PY
)" | head -c 600
echo
echo
echo "== If you still see mock*, check server error logs =="
ssh "$HOST_ALIAS" 'pm2 logs singsync-api --err --lines 30 || true'
