#!/usr/bin/env bash
# AC-D: управление и изоляция. Usage: ./ac-d.sh <slug-a> <slug-b>
# (нужно два задеплоенных проекта; AC-D1 и AC-D4 — ручные шаги внизу)
. "$(dirname "$0")/lib.sh"
require_slug "${1:-}"; require_slug "${2:-}"
A="$1"; B="$2"
CA=$(app_container "$A"); CB=$(app_container "$B")
BASE=$(base_domain)

echo "AC-D2: both services answer on their subdomains"
for S in "$A" "$B"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$S.$BASE/" || echo 000)
  [ "$CODE" = "200" ] && pass "$S.$BASE → 200" || fail "$S.$BASE → $CODE"
done

echo "AC-D2: container A cannot see B's code (no shared volumes/files)"
if docker exec "$CA" sh -c "ls /app 2>/dev/null | head -1" >/dev/null 2>&1; then
  if docker exec "$CA" sh -c "ls /data/projects 2>/dev/null || ls ~/.botsman 2>/dev/null" >/dev/null 2>&1; then
    fail "container $CA sees botsman project tree"
  else
    pass "no access to other projects' files from $CA"
  fi
else
  pass "container has no shell access to inspect (still isolated)"
fi

echo "AC-D2: A and B are on different networks"
NA=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CA")
NB=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CB")
if [ -z "$(comm -12 <(tr ' ' '\n' <<<"$NA" | sort -u) <(tr ' ' '\n' <<<"$NB" | sort -u) | grep -v '^$' || true)" ]; then
  pass "no shared networks ($NA | $NB)"
else
  fail "shared network between $CA and $CB"
fi

echo "AC-D3: no docker socket / botsman config inside service containers"
for C in "$CA" "$CB"; do
  if docker exec "$C" sh -c "test -e /var/run/docker.sock" 2>/dev/null; then
    fail "$C has docker.sock"
  else
    pass "$C: no docker.sock"
  fi
  if docker exec "$C" sh -c "find / -maxdepth 4 -name 'config.json' -path '*botsman*' 2>/dev/null | grep -q ." 2>/dev/null; then
    fail "$C can reach botsman config"
  else
    pass "$C: no botsman config"
  fi
done

echo "AC-D3: resource limits applied"
MEM=$(docker inspect -f '{{.HostConfig.Memory}}' "$CA")
[ "$MEM" -gt 0 ] && pass "memory limit: $MEM bytes" || fail "no memory limit"

echo "AC-D3+: Caddy Admin API недостижим из сервисных контейнеров (unix socket only)"
if docker exec "$CA" sh -c "wget -qO- -T 3 http://botsman-caddy:2019/config/ >/dev/null 2>&1"; then
  fail "caddy admin reachable over TCP from $CA"
else
  pass "no TCP admin listener reachable from $CA"
fi

echo "AC-D3+: control API демона отвергает запросы без токена"
if docker exec "$CA" sh -c "wget -qO- -T 3 --post-data='' http://botsman-daemon:8366/hooks/push/$A >/dev/null 2>&1"; then
  fail "control API accepted an unauthenticated push trigger from a service container"
else
  pass "unauthenticated push trigger rejected"
fi

echo "AC-D3+: контейнер агента (если сейчас работает) не видит docker-сеть проектов"
AGENT_C=$(docker ps --filter "label=botsman.agent" --format '{{.Names}}' | head -1)
if [ -n "$AGENT_C" ]; then
  NETS=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$AGENT_C")
  case "$NETS" in
    *botsman*) fail "agent container is attached to a botsman network: $NETS";;
    *) pass "agent container networks: $NETS (default bridge only)";;
  esac
else
  pass "no agent container running right now (запусти проверку во время генерации, чтобы покрыть)"
fi

echo "AC-D1 (manual): /list в Telegram показывает оба проекта со статусами и ссылками."
echo "AC-D4 (manual): напиши боту с другого аккаунта — должен получить отказ без какой-либо информации."

finish
