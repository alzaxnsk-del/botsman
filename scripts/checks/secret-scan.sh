#!/usr/bin/env bash
# AC-B5: grep for typical hardcoded-secret patterns in a project dir. Exit 1 if found.
set -euo pipefail
DIR="${1:?usage: secret-scan.sh <project-dir>}"
PATTERNS=(
  'sk-ant-[a-zA-Z0-9_-]\{20,\}'
  'AKIA[0-9A-Z]\{16\}'
  'gh[pousr]_[A-Za-z0-9]\{36,\}'
  '[0-9]\{8,10\}:[A-Za-z0-9_-]\{30,\}'
  '-----BEGIN .*PRIVATE KEY-----'
)
FOUND=0
for p in "${PATTERNS[@]}"; do
  if grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude=.env -e "$p" "$DIR" 2>/dev/null; then
    FOUND=1
  fi
done
exit $FOUND
