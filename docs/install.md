# Installation

Full setup guide for a clean Ubuntu 22.04 / 24.04 VPS.

## Before you start

You need:

1. **A VPS** — Ubuntu 22.04 or 24.04, 2 vCPU / 4 GB RAM, 40+ GB disk, ports 80
   and 443 open.
2. **A wildcard DNS record.** Pick a base domain for your services, e.g.
   `example.com`. In your DNS provider's control panel create one record:

   | Type | Host / Name | Value |
   |---|---|---|
   | A | `*` | `<your server's public IP>` |

   This makes *every* subdomain (`todo.example.com`,
   `price-watcher.example.com`, …) resolve to your server, so each
   deployed project gets its own address with no extra DNS work. (If the domain
   is shared with a website, use a sub-base like `apps.example.com` with host
   `*.apps` instead.) Without it links and TLS will not work. Verify (may take a
   few minutes to propagate):

   ```bash
   dig +short anything.example.com   # → your server IP
   ```

   The setup wizard also checks the record and warns if it does not resolve.

   > **Cloudflare users:** set the record to **DNS only** (grey cloud), not
   > Proxied. Botsman's Caddy issues its own Let's Encrypt certificates, and
   > the Cloudflare proxy breaks the ACME challenges (you'd get 5xx errors or
   > redirect loops).
3. **A Telegram bot token** — create a bot with [@BotFather](https://t.me/BotFather).
4. **Your Telegram user ID** — ask [@userinfobot](https://t.me/userinfobot).
5. **Coding agent auth** — pick one (bring-your-own: Botsman never proxies or resells tokens):
   - **Claude subscription (Pro/Max)** — no extra bills on top of the plan. On any
     machine where you are logged into Claude Code, run `claude setup-token` and
     keep the resulting `sk-ant-oat…` token for the wizard. Usage counts against
     your subscription limits (5-hour windows / weekly caps).
   - **Anthropic API key** (`sk-ant-api…`, pay-per-use) from
     [console.anthropic.com](https://console.anthropic.com).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | bash
```

The script, in one pass:

1. Installs Docker if missing and enables it at boot (survives reboots).
2. Clones the repo into `/opt/botsman` and builds the image.
3. Asks two questions in the console: your **bot token** (live-checked) and
   your **Telegram user ID**. That's all the console needs.
4. Starts `docker compose`: the daemon + Caddy (automatic Let's Encrypt) +
   Postgres.

Then open Telegram and send your bot `/start` — it finishes the setup in the
chat, step by step:

1. **Coding agent** — pick Claude subscription or API key with a button and
   paste the token; the bot validates it live and deletes your message with
   the secret right away.
2. **Domain** — the bot shows the exact wildcard A-record to create (with this
   server's real IP), checks it live, detects a Cloudflare-proxied record and
   waits with a "Re-check" button until DNS propagates.
3. **Telemetry** — one tap, off by default.

After the last step the daemon restarts itself with the full config and the
bot says it is ready for the first service. Change any of these later with
`/setup` in the chat.

> **Root or sudo?** Both are supported. On a fresh VPS where you log in as
> root, just run the command as is — the daemon will run as root, but the
> coding agent and all deployed services always run as unprivileged users in
> isolated containers. With a sudo user, state lives in that user's
> `~/.botsman` and `git push` deploys work over that user's SSH.

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
| `anthropicApiKey` | one of the two | pay-per-use API key (`sk-ant-api…`) |
| `claudeCodeOauthToken` | one of the two | Claude subscription token from `claude setup-token` (`sk-ant-oat…`); wins if both are set |
| `baseDomain` | set in chat | e.g. `example.com`; collected during in-chat onboarding |
| `telemetry.enabled` | no | default `false`; see below |
| `telemetry.endpoint` | no | without it nothing is ever sent, even if enabled |
| `agent.maxTurns` | no | agent iteration cap per task (default 60) |
| `agent.timeoutMs` | no | hard wall-clock cap per task (default 720000 = 12 min) |
| `agent.model` | no | coding-agent model: `opus` (default — best quality), `sonnet` (balanced), or `haiku` (fastest). Pick it in onboarding or anytime via `/setup` → 🧠 Model |
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
