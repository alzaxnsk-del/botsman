#!/usr/bin/env bash
# Shared helpers for acceptance checks (§7). Each check prints PASS/FAIL and
# exits non-zero on failure, so they can run in CI or by hand on the VPS.
set -euo pipefail

BOTSMAN_HOME="${BOTSMAN_HOME:-$HOME/.botsman}"
FAILURES=0

pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

require_slug() {
  if [ -z "${1:-}" ]; then
    echo "Usage: $0 <slug> [...]" >&2
    exit 2
  fi
}

base_domain() {
  python3 -c "import json;print(json.load(open('$BOTSMAN_HOME/config.json'))['baseDomain'])" 2>/dev/null \
    || docker run --rm -v "$BOTSMAN_HOME:/data:ro" node:22-alpine \
       node -e "console.log(require('/data/config.json').baseDomain)"
}

app_container() { # newest container of a project
  docker ps -a --filter "label=botsman.project=$1" --format '{{.Names}}' | head -1
}

finish() {
  echo
  if [ "$FAILURES" -eq 0 ]; then
    echo "ALL CHECKS PASSED"
  else
    echo "$FAILURES CHECK(S) FAILED"
    exit 1
  fi
}
