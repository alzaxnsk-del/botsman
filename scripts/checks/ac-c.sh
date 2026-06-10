#!/usr/bin/env bash
# AC-C: iteration and rollback.
#   AC-C1 (manual trigger): message the bot "<slug> add a dark theme", wait for ✅,
#     then run this script — it verifies the new commit and that the site is alive.
#   AC-C2 (manual trigger): send an edit that breaks the build (e.g.
#     "<slug> add a RUN exit 1 line to the Dockerfile"), wait for ❌ —
#     the script verifies the old version still answers 200.
#   AC-C3: /rollback <slug> in Telegram; the script measures availability.
# Usage: ./ac-c.sh <slug>
. "$(dirname "$0")/lib.sh"
require_slug "${1:-}"
SLUG="$1"
DOMAIN="$SLUG.$(base_domain)"
PROJ="$BOTSMAN_HOME/projects/$SLUG"

echo "AC-C1: git history grows with agent commits"
N=$(git -C "$PROJ" log --oneline | wc -l)
if [ "$N" -ge 2 ]; then pass "history has $N commits"; else fail "expected ≥2 commits after an edit, got $N"; fi

echo "AC-C1/AC-C2: service answers 200 right now"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/" || echo 000)
[ "$CODE" = "200" ] && pass "live version answers 200" || fail "service down: $CODE"

echo "AC-C3: rollback responsiveness probe (run right after /rollback in Telegram)"
START=$(date +%s)
OK=0
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/" || echo 000)
  if [ "$CODE" = "200" ]; then OK=1; break; fi
  sleep 2
done
ELAPSED=$(( $(date +%s) - START ))
if [ "$OK" = "1" ] && [ "$ELAPSED" -le 120 ]; then
  pass "answers 200 within ${ELAPSED}s (≤120s)"
else
  fail "no 200 within 120s"
fi

finish
