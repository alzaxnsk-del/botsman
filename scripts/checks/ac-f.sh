#!/usr/bin/env bash
# AC-F1: падение одного сервиса не задевает остальные. Usage: ./ac-f.sh <slug-a> <slug-b>
# AC-F2 проверяется конфигурацией (maxTurns/timeout) и вручную; см. низ скрипта.
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
echo "  $CA running=$RUNNING (информативно; /status и /list должны показать факт падения)"

echo "AC-F1 (manual): /status $A в Telegram должен отметить, что контейнер не работает."
echo "AC-F2 (manual): попроси бота сделать заведомо неосуществимое — задача должна"
echo "  завершиться отчётом об ошибке в пределах таймаута (по умолчанию 12 мин),"
echo "  бот остаётся отзывчивым (например, /list отвечает во время задачи)."

finish
