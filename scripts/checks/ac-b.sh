#!/usr/bin/env bash
# AC-B: главный сценарий создания. Перед запуском отправь боту в Telegram:
#   «сделай TODO-сервис со списком задач и возможностью отмечать выполненные»
# дождись ответа со ссылкой (AC-B4: ≤15 минут) и скриншотом (AC-B3 — глазами),
# затем:  ./ac-b.sh <slug>
. "$(dirname "$0")/lib.sh"
require_slug "${1:-}"
SLUG="$1"
DOMAIN="$SLUG.$(base_domain)"

echo "AC-B1: HTTPS 200 with valid TLS on https://$DOMAIN/"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/" || echo 000)
if [ "$CODE" = "200" ]; then
  pass "HTTP 200 with verified certificate"
else
  fail "got $CODE from https://$DOMAIN/ (000 = TLS/conn failure)"
fi

echo "AC-B2: persistence across container restart"
C=$(app_container "$SLUG")
MARKER="ac-b2-$(date +%s)"
curl -fsS -X POST "https://$DOMAIN/add" --data-urlencode "title=$MARKER" >/dev/null \
  || fail "could not create a record via POST /add (если форма другая — добавь запись руками и перезапусти контейнер)"
docker restart "$C" >/dev/null
sleep 8
if curl -fsS --max-time 20 "https://$DOMAIN/" | grep -q "$MARKER"; then
  pass "record '$MARKER' survived container restart (Postgres persistence)"
else
  fail "record lost after restart"
fi

echo "AC-B5: git history is meaningful, no hardcoded secrets"
PROJ="$BOTSMAN_HOME/projects/$SLUG"
COMMITS=$(git -C "$PROJ" log --oneline | wc -l)
if [ "$COMMITS" -ge 1 ] && git -C "$PROJ" log --format=%s | grep -q '^botsman:'; then
  pass "$COMMITS commit(s), agent commits prefixed 'botsman:'"
else
  fail "git history missing or unprefixed"
fi
bash "$(dirname "$0")/secret-scan.sh" "$PROJ" && pass "no hardcoded secrets" || fail "secret patterns found"

echo "AC-B3/AC-B4 (manual): link + real screenshot received in Telegram within 15 min."

finish
