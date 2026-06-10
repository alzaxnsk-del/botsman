#!/usr/bin/env bash
# Botsman installer for clean Ubuntu 22.04 / 24.04 (AC-A1).
# Usage:  curl -fsSL https://raw.githubusercontent.com/<you>/botsman/main/install.sh | bash
# Env:    BOTSMAN_REPO  — git URL of the botsman repo (default below)
#         BOTSMAN_DIR   — install dir (default /opt/botsman)
set -euo pipefail

BOTSMAN_REPO="${BOTSMAN_REPO:-https://github.com/botsman/botsman.git}"
BOTSMAN_DIR="${BOTSMAN_DIR:-/opt/botsman}"

log()  { echo -e "\033[1;32m[botsman]\033[0m $*"; }
fail() { echo -e "\033[1;31m[botsman]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"

. /etc/os-release 2>/dev/null || true
case "${VERSION_ID:-}" in
  22.04|24.04) ;;
  *) log "ВНИМАНИЕ: тестировалось на Ubuntu 22.04/24.04, у тебя ${PRETTY_NAME:-неизвестная ОС}. Продолжаю...";;
esac

log "Ставлю базовые пакеты..."
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  log "Docker не найден — устанавливаю (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker  # переживает reboot (AC-A2)

if [ -d "$BOTSMAN_DIR/.git" ]; then
  log "Обновляю код в $BOTSMAN_DIR..."
  git -C "$BOTSMAN_DIR" pull --ff-only
else
  log "Клонирую $BOTSMAN_REPO в $BOTSMAN_DIR..."
  git clone --depth 1 "$BOTSMAN_REPO" "$BOTSMAN_DIR"
fi
cd "$BOTSMAN_DIR"

# Состояние живёт в ~/.botsman настоящего пользователя (не root'а при sudo).
REAL_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"
BOTSMAN_HOME="${REAL_HOME}/.botsman"
mkdir -p "$BOTSMAN_HOME"
chmod 700 "$BOTSMAN_HOME"

if [ ! -f .env ]; then
  log "Генерирую .env (пароль Postgres, UID владельца, GID docker-сокета)..."
  {
    echo "BOTSMAN_PG_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    echo "BOTSMAN_HOME=$BOTSMAN_HOME"
    # Демон работает под UID владельца, чтобы git push в ~/.botsman/repos работал по SSH.
    echo "BOTSMAN_UID=$(id -u "${SUDO_USER:-root}")"
    echo "BOTSMAN_GID=$(id -g "${SUDO_USER:-root}")"
    echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)"
  } > .env
  chmod 600 .env
fi
chown -R "${SUDO_USER:-root}:" "$BOTSMAN_HOME"

log "Собираю образ Botsman (несколько минут на первом запуске)..."
docker compose build --quiet

if [ ! -f "$BOTSMAN_HOME/config.json" ]; then
  log "Запускаю мастер настройки..."
  # curl|bash: stdin занят пайпом, мастеру нужен терминал.
  if ! docker compose run --rm --no-deps botsman setup </dev/tty; then
    fail "Мастер настройки не завершён. Исправь данные и запусти заново:
  cd $BOTSMAN_DIR && docker compose run --rm --no-deps botsman setup && docker compose up -d"
  fi
fi

log "Запускаю Botsman (демон + Caddy + Postgres)..."
docker compose up -d

log "Проверяю, что демон жив..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8366/health >/dev/null 2>&1; then
    log "✓ Botsman запущен."
    log "Напиши своему боту в Telegram /start — и опиши первый сервис."
    log "Не забудь wildcard DNS: *.<твой-домен> → IP этого сервера."
    exit 0
  fi
  sleep 2
done
docker compose logs --tail 30 botsman || true
fail "Демон не ответил на healthcheck за 60 секунд — смотри логи выше (docker compose logs botsman)."
