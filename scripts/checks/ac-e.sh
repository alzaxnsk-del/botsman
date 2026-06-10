#!/usr/bin/env bash
# AC-E1: push-to-deploy. Run on the VPS. Usage: ./ac-e.sh <slug>
. "$(dirname "$0")/lib.sh"
require_slug "${1:-}"
SLUG="$1"
DOMAIN="$SLUG.$(base_domain)"
BARE="$BOTSMAN_HOME/repos/$SLUG.git"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "AC-E1: clone, commit, push, autodeploy"
git clone -q "$BARE" "$TMP/clone"
MARKER="manual-edit-$(date +%s)"
echo "<!-- $MARKER -->" >> "$TMP/clone/README.md" 2>/dev/null || echo "<!-- $MARKER -->" > "$TMP/clone/README.md"
git -C "$TMP/clone" -c user.name=tester -c user.email=t@local add -A
git -C "$TMP/clone" -c user.name=tester -c user.email=t@local commit -qm "manual: add marker $MARKER"
git -C "$TMP/clone" push -q origin main

echo "  waiting for redeploy (up to 5 min)..."
OK=0
for i in $(seq 1 60); do
  sleep 5
  CUR=$(git -C "$BOTSMAN_HOME/projects/$SLUG" log -1 --format=%s 2>/dev/null || true)
  if echo "$CUR" | grep -q "$MARKER"; then OK=1; break; fi
done
[ "$OK" = 1 ] && pass "working tree picked up the pushed commit" || fail "pushed commit not deployed in 5 min"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/" || echo 000)
[ "$CODE" = "200" ] && pass "service alive after push-deploy" || fail "service down after push: $CODE"

echo "AC-E1: history distinguishes manual vs agent commits"
if git -C "$BOTSMAN_HOME/projects/$SLUG" log --format=%s | grep -q '^botsman:' \
   && git -C "$BOTSMAN_HOME/projects/$SLUG" log --format=%s | grep -qv '^botsman:'; then
  pass "both 'botsman:' and manual commits present"
else
  fail "cannot distinguish commit authorship in history"
fi

finish
