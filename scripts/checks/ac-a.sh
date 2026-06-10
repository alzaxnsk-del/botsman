#!/usr/bin/env bash
# AC-A: installation. Run on the VPS after install.sh.
#   AC-A1 — the system came up from a single script (we verify the result)
#   AC-A2 — survives a reboot: run `reboot`, wait 2 minutes and run
#           this script again — it must pass.
#   AC-A3 — wizard with an invalid key: see the interactive step below.
. "$(dirname "$0")/lib.sh"

echo "AC-A1: daemon, caddy, postgres are up"
for c in botsman-daemon botsman-caddy botsman-postgres; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then
    pass "$c running"
  else
    fail "$c not running"
  fi
done

echo "AC-A1: daemon healthcheck"
if curl -fsS -m 5 http://127.0.0.1:8366/health | grep -q '"ok":true'; then
  pass "control API healthy"
else
  fail "control API not responding on 127.0.0.1:8366"
fi

echo "AC-A1: config exists with 600 permissions"
PERMS=$(stat -c '%a' "$BOTSMAN_HOME/config.json" 2>/dev/null || echo missing)
if [ "$PERMS" = "600" ]; then
  pass "config.json mode 600"
else
  fail "config.json perms: $PERMS (expected 600)"
fi

echo "AC-A2: containers restart policy survives reboot"
for c in botsman-daemon botsman-caddy botsman-postgres; do
  P=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo none)
  if [ "$P" = "unless-stopped" ]; then pass "$c restart=$P"; else fail "$c restart=$P"; fi
done
systemctl is-enabled docker >/dev/null 2>&1 && pass "docker enabled at boot" || fail "docker not enabled at boot"

echo "AC-A3 (manual): run 'docker compose run --rm --no-deps botsman setup' with an"
echo "  invalid Anthropic key — expect a clear error and exit code 1, no traceback."

finish
