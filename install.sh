#!/usr/bin/env bash
# Botsman installer for clean Ubuntu 22.04 / 24.04 (AC-A1).
# Usage:  curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | bash
# Env:    BOTSMAN_REPO  — git URL of the botsman repo (default below)
#         BOTSMAN_DIR   — install dir (default /opt/botsman)
set -euo pipefail

BOTSMAN_REPO="${BOTSMAN_REPO:-https://github.com/alzaxnsk-del/botsman.git}"
BOTSMAN_DIR="${BOTSMAN_DIR:-/opt/botsman}"

log()  { echo -e "\033[1;32m[botsman]\033[0m $*"; }
fail() { echo -e "\033[1;31m[botsman]\033[0m $*" >&2; exit 1; }

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
  *) log "WARNING: this installer targets Ubuntu 22.04/24.04, you are on ${PRETTY_NAME:-an unknown OS}. Continuing...";;
esac

log "Installing base packages..."
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found — installing (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker  # survives reboot (AC-A2)

if [ -d "$BOTSMAN_DIR/.git" ]; then
  log "Updating code in $BOTSMAN_DIR..."
  git -C "$BOTSMAN_DIR" pull --ff-only
else
  log "Cloning $BOTSMAN_REPO into $BOTSMAN_DIR..."
  git clone --depth 1 "$BOTSMAN_REPO" "$BOTSMAN_DIR"
fi
cd "$BOTSMAN_DIR"

# State lives in ~/.botsman of the real user (not root's when run via sudo).
REAL_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
BOTSMAN_HOME="${REAL_HOME}/.botsman"
mkdir -p "$BOTSMAN_HOME"
chmod 700 "$BOTSMAN_HOME"

if [ ! -f .env ]; then
  log "Generating .env (Postgres password, owner UID, docker socket GID)..."
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

log "Building the Botsman image (takes several minutes on the first run)..."
docker compose build --quiet

if [ ! -f "$BOTSMAN_HOME/config.json" ]; then
  log "Starting the setup wizard..."
  # curl|bash: stdin is taken by the pipe, the wizard needs a terminal.
  if ! docker compose run --rm --no-deps botsman setup </dev/tty; then
    fail "Setup wizard did not finish. Fix the inputs and run it again:
  cd $BOTSMAN_DIR && docker compose run --rm --no-deps botsman setup && docker compose up -d"
  fi
fi

log "Starting Botsman (daemon + Caddy + Postgres)..."
docker compose up -d

log "Waiting for the daemon to come up..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8366/health >/dev/null 2>&1; then
    log "✓ Botsman is running."
    log "Message your Telegram bot /start — and describe your first service."
    log "Don't forget the wildcard DNS record: *.<your-domain> → this server's IP."
    exit 0
  fi
  sleep 2
done
docker compose logs --tail 30 botsman || true
fail "The daemon did not answer the healthcheck within 60 seconds — see the logs above (docker compose logs botsman)."
