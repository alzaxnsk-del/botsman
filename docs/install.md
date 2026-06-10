# Installation

Full setup guide for a clean Ubuntu 22.04 / 24.04 VPS. Русская версия всей
документации: [README.ru.md](README.ru.md).

## Before you start

You need:

1. **A VPS** — Ubuntu 22.04 or 24.04, 2 vCPU / 4 GB RAM, 40+ GB disk, ports 80
   and 443 open.
2. **A wildcard DNS record.** Pick a base domain for your services, e.g.
   `apps.example.com`, and create an A-record `*.apps.example.com → <server IP>`
   at your DNS provider. Without it links and TLS will not work. Verify:
   `dig anything.apps.example.com` should return your server IP.
3. **A Telegram bot token** — create a bot with [@BotFather](https://t.me/BotFather).
4. **Your Telegram user ID** — ask [@userinfobot](https://t.me/userinfobot).
5. **An Anthropic API key** (`sk-ant-…`) from [console.anthropic.com](https://console.anthropic.com).
   Bring-your-own-key: Botsman never proxies or resells tokens.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | bash
```

The script, in one pass:

1. Installs Docker if missing and enables it at boot (survives reboots).
2. Clones the repo into `/opt/botsman` and builds the image.
3. Runs an interactive wizard: bot token → your Telegram ID → API key → base
   domain → telemetry opt-in (default **off**). Tokens are validated with live
   probes; an invalid key ends the wizard with a clear error, not a traceback.
4. Starts `docker compose`: the daemon + Caddy (automatic Let's Encrypt) +
   Postgres.

Then message your bot `/start` and describe your first service.

## Where things live

| Path | What |
|---|---|
| `~/.botsman/config.json` | tokens and settings, `chmod 600` |
| `~/.botsman/projects/<slug>/` | one git repo per project |
| `~/.botsman/repos/<slug>.git` | bare repos for push-to-deploy |
| `~/.botsman/botsman.db` | SQLite state |
| `~/.botsman/logs/` | structured daemon logs (rotated) |
| `/opt/botsman/.env` | compose env: Postgres password, owner UID |

## Config reference

Edit `~/.botsman/config.json`, then `docker compose restart botsman`.

| Key | Required | Description |
|---|---|---|
| `telegramBotToken` | yes | from @BotFather |
| `ownerIds` | yes | array of whitelisted Telegram user IDs |
| `anthropicApiKey` | yes | your API key (BYO-key) |
| `baseDomain` | yes | e.g. `apps.example.com` |
| `telemetry.enabled` | no | default `false`; see below |
| `telemetry.endpoint` | no | without it nothing is ever sent, even if enabled |
| `agent.maxTurns` | no | agent iteration cap per task (default 60) |
| `agent.timeoutMs` | no | hard wall-clock cap per task (default 720000 = 12 min) |
| `agent.model` | no | Claude model override |
| `agent.image` | no | docker image for agent containers (default `botsman`) |
| `docker.socketPath` | no | default `/var/run/docker.sock` |
| `caddyAdminUrl` | no | default `unix:/run/caddy/admin.sock` |

### Telemetry

Strictly opt-in, asked once during setup, default off. Even when enabled,
there is **no built-in endpoint**: until you set `telemetry.endpoint`, events
are only written to local logs and SQLite. When an endpoint is set, exactly
three anonymous lifecycle events are sent (install, first deploy, activity
after 7 days) — never code, prompts or project content.

## Working from your laptop

`/status <slug>` in Telegram shows the git clone URL. Then:

```bash
git clone <user>@<server>:~/.botsman/repos/<slug>.git
# edit, commit
git push   # triggers an automatic redeploy; result arrives in Telegram
```

Agent commits are prefixed `botsman:`; yours are not.

## Verifying the install

Acceptance check scripts live in `scripts/checks/` (run them on the VPS):
`ac-a.sh` for the installation itself, `ac-b.sh <slug>` after your first
deployed service, and so on. Each prints PASS/FAIL per criterion.

## Re-running the wizard / uninstall

```bash
cd /opt/botsman
docker compose run --rm --no-deps botsman setup   # re-run wizard
docker compose up -d

docker compose down                                # stop botsman
# deployed services are separate containers: stop via /delete in Telegram first
```
