#!/usr/bin/env bash
# AC-F1: one service crashing must not affect the others. Usage: ./ac-f.sh <slug-a> <slug-b>
# AC-F2 is covered by config (maxTurns/timeout) and manually; see the bottom of this script.
. "$(dirname "$0")/lib.sh"
require_slug "${1:-}"; require_slug "${2:-}"
A="$1"; B="$2"
BASE=$(base_domain)
CA=$(app_container "$A")

echo "AC-F1: killing $CA, checking $B stays alive"
docker kill "$CA" >/dev/null
sleep 3
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$B.$BASE/" || echo 000)
[ "$CODE" = "200" ] && pass "$B unaffected (200)" || fail "$B affected: $CODE"

echo "AC-F1: daemon stays healthy"
curl -fsS -m 5 http://127.0.0.1:8366/health >/dev/null && pass "daemon healthy" || fail "daemon down"

echo "  (restart policy should revive $CA; checking in 30s...)"
sleep 30
RUNNING=$(docker inspect -f '{{.State.Running}}' "$CA" 2>/dev/null || echo false)
echo "  $CA running=$RUNNING (informational; /status and /list must reflect the crash)"

echo "AC-F1 (manual): /status $A in Telegram must note the container is down."
echo "AC-F2 (manual): ask the bot for something impossible — the task must"
echo "  end with an error report within the timeout (12 min by default),"
echo "  and the bot stays responsive (e.g. /list answers during the task)."

finish
