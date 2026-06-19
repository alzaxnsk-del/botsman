#!/usr/bin/env bash
# Botsman installer for clean Ubuntu 22.04 / 24.04 (AC-A1).
# Usage:  curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | sudo bash
# Env:    BOTSMAN_REPO  — git URL of the botsman repo (default below)
#         BOTSMAN_DIR   — install dir (default /opt/botsman)
set -euo pipefail

BOTSMAN_REPO="${BOTSMAN_REPO:-https://github.com/alzaxnsk-del/botsman.git}"
BOTSMAN_DIR="${BOTSMAN_DIR:-/opt/botsman}"
TOTAL=7

# --- look & feel -------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  A=$'\033[38;5;208m'; B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; X=$'\033[0m'
else
  A=''; B=''; D=''; G=''; R=''; X=''
fi

say()    { printf '%s\n' "$*"; }
step()   { say ""; say "  ${A}[$1/${TOTAL}]${X} ${B}$2${X}"; }
ok()     { say "        ${G}✓${X} $*"; }
info()   { say "        ${D}$*${X}"; }
fail()   { say ""; say "  ${R}✗ $*${X}" >&2; exit 1; }
divider(){ say "  ${D}──────────────────────────────────────────────${X}"; }

say ""
say "  ${A}◆${X} ${B}Botsman${X}"
say "    ${D}Describe a service in chat — get it deployed on your own server.${X}"
say ""
say "    ${B}Before we start, have these two things ready:${X}"
say "      • A Telegram bot token from @BotFather       ${D}(https://t.me/BotFather)${X}"
say "      • Your numeric Telegram ID from @userinfobot  ${D}(https://t.me/userinfobot)${X}"
say "    ${D}You'll paste them at the end — no need to leave this terminal until then.${X}"
say ""
divider

# --- preconditions -----------------------------------------------------------
# Root needed. Re-exec via sudo only when running from a file: with
# `curl | bash` $0 is just "bash", so re-exec would break — ask for sudo instead.
if [ "$(id -u)" -ne 0 ]; then
  if [ -f "$0" ]; then
    exec sudo -E bash "$0" "$@"
  fi
  fail "Root privileges required. Run it like this:
    curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | sudo bash"
fi

export DEBIAN_FRONTEND=noninteractive

. /etc/os-release 2>/dev/null || true
case "${VERSION_ID:-}" in
  22.04|24.04) ;;
  *) say "  ${D}Note: built for Ubuntu 22.04/24.04, you are on ${PRETTY_NAME:-an unknown OS}. Continuing…${X}";;
esac

step 1 "System packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null
ok "curl, git, ca-certificates"

step 2 "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "already installed ($(docker --version | sed 's/Docker version //;s/,.*//'))"
else
  info "not found — installing from get.docker.com…"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  ok "installed"
fi
systemctl enable --now docker >/dev/null 2>&1  # survives reboot (AC-A2)
ok "starts automatically on boot"

step 3 "Botsman code"
if [ -d "$BOTSMAN_DIR/.git" ]; then
  git -C "$BOTSMAN_DIR" pull --ff-only --quiet
  ok "updated $BOTSMAN_DIR"
else
  git clone --depth 1 --quiet "$BOTSMAN_REPO" "$BOTSMAN_DIR"
  ok "cloned into $BOTSMAN_DIR"
fi
cd "$BOTSMAN_DIR"

step 4 "Environment"
# State lives in ~/.botsman of the real user (not root's when run via sudo).
REAL_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
BOTSMAN_HOME="${REAL_HOME}/.botsman"
mkdir -p "$BOTSMAN_HOME"
chmod 700 "$BOTSMAN_HOME"
if [ -z "${SUDO_USER:-}" ]; then
  ok "installing as root — fully supported"
  info "the daemon runs as root; coding agents and deployed services run unprivileged"
else
  ok "installing for user ${SUDO_USER}"
fi
if [ ! -f .env ]; then
  {
    echo "BOTSMAN_PG_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    echo "BOTSMAN_HOME=$BOTSMAN_HOME"
    # The daemon runs as the owner's UID so that git push into ~/.botsman/repos works over SSH.
    echo "BOTSMAN_UID=$(id -u "${SUDO_USER:-root}")"
    echo "BOTSMAN_GID=$(id -g "${SUDO_USER:-root}")"
    echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)"
  } > .env
  chmod 600 .env
fi
chown -R "${SUDO_USER:-root}:" "$BOTSMAN_HOME"
ok "state directory: $BOTSMAN_HOME"

step 5 "Building the Botsman image"
info "takes several minutes on the first run — good moment for a coffee ☕"
docker compose build --quiet
ok "image built"

step 6 "Setup — two questions, the rest happens in Telegram"
if [ -f "$BOTSMAN_HOME/config.json" ]; then
  ok "existing config found — skipping (re-run anytime: docker compose run --rm --no-deps botsman setup)"
else
  # curl|bash: stdin is taken by the pipe, the wizard needs a terminal.
  if ! docker compose run --rm --no-deps botsman setup </dev/tty; then
    fail "Setup did not finish. Fix the inputs and run it again:
    cd $BOTSMAN_DIR && docker compose run --rm --no-deps botsman setup && docker compose up -d"
  fi
fi

step 7 "Starting services"
docker compose up -d --quiet-pull 2>/dev/null || docker compose up -d
info "daemon + Caddy (HTTPS) + Postgres"
HEALTHY=0
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:8366/health >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" != "1" ]; then
  docker compose logs --tail 30 botsman || true
  fail "The daemon didn't answer the health check within 90 seconds — the build may still be settling.
    Try, in order:
      1) wait ~30s, then:  curl -fsS http://127.0.0.1:8366/health
      2) watch the logs:   cd $BOTSMAN_DIR && docker compose logs -f botsman
      3) re-run if needed: cd $BOTSMAN_DIR && docker compose up -d"
fi
ok "all services are up"

say ""
divider
say ""
say "  ${G}${B}✓ Botsman is running!${X}"
say ""
say "    ${B}Next:${X} open Telegram and send your bot ${B}/start${X}"
say "    It will finish the setup right in the chat (coding agent, domain) —"
say "    and then build your first service from a plain description."
say ""
say "    ${D}Docs: https://github.com/alzaxnsk-del/botsman${X}"
say ""
