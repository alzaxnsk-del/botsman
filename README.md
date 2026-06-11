# Botsman

**Describe a web service in a chat message. Botsman builds it, deploys it to your own server with a real domain and HTTPS, and sends you back a working link.**

Botsman runs on your VPS. You talk to it from Telegram (or push code from your laptop). A coding agent writes the service, Botsman containerizes it, gives it a subdomain with automatic TLS, runs a smoke check, and replies with a link and a screenshot. Want a change? Just say so in the chat. Your code, your server, your API key — nothing is resold or locked in.

> ⚠️ **Early stage.** Botsman is in active early development. Expect rough edges, breaking changes, and missing features. Do **not** run it on a server hosting anything you can't afford to lose. See [Security](#security) before installing.

---

## Why

Vibe-coding tools made *building* software trivial. But they made *owning* it expensive: subscriptions that scale with your codebase, vendor lock-in, and code that lives on someone else's platform.

The alternative — your own server with Coolify/Dokploy + GitHub + a local coding agent — is cheap and free, but every new project is 40–90 minutes of plumbing (repo, env, database, domain, SSL, deploy pipeline), and the iteration loop is split across three tools.

Botsman is the missing piece: the magic of "a sentence becomes a deployed service," on infrastructure you control, at the cost of the compute you actually use.

---

## How it works

```
You (Telegram):
  "Build a service: a form where I paste a product URL, it checks the
   price hourly and pings me on Telegram if it drops."

Botsman (a few minutes later):
  ✓ price-watcher.yourdomain.com — deployed
  ✓ Database created
  ✓ Checks passed
  [link]  [screenshot of the running page]
  What would you like to change?

You: "add a dark theme and a page listing everything I'm tracking"
Botsman: ✓ Updated. Same link.
```

Under the hood:

1. **Telegram gateway** receives your message (only from your whitelisted account).
2. **Orchestrator** creates a git repo for the project and runs a **coding agent** to generate the code.
3. **Deploy engine** builds a container, routes `<project>.<your-domain>` through a reverse proxy with automatic Let's Encrypt TLS, and runs a smoke check.
4. You get a link and a screenshot. Every change is a new commit; you can `git clone`, edit on your laptop, and `git push` to redeploy.

---

## Key ideas

- **Your server, your code.** Everything runs on your VPS. Each project is a plain git repo on disk — clone it, edit it in any IDE, push to redeploy. Leaving Botsman is one `git clone` away (which is exactly why you won't need to).
- **Bring your own key.** Botsman never proxies or resells LLM tokens. You plug in your own API key (or subscription). Your bill for intelligence stays yours and transparent.
- **Phone and laptop are equal doors.** Sketch a service from Telegram on your commute, finish it by hand in your editor in the evening — same project, no migration.
- **Boring, predictable deploys.** One supported service stack, containerized, with health checks and one-command rollback. Magic where it helps, predictability where it matters.

---

## Requirements

- A Linux VPS (Ubuntu 22.04 or 24.04), 2 vCPU / 4 GB RAM is a comfortable starting point.
- A domain with a **wildcard DNS record** pointing at your server, e.g. `*.yourdomain.com → <your server IP>`.
- A Telegram bot token (from [@BotFather](https://t.me/BotFather)) and your Telegram user ID.
- Auth for the coding agent — either of:
  - your **Claude subscription** (Pro/Max): generate a token with `claude setup-token` on a machine where you're logged into Claude Code — no extra API bills, usage counts against your plan limits;
  - an **Anthropic API key** (pay-per-use, [console.anthropic.com](https://console.anthropic.com)).

---

## Quick start

Have a domain ready: each project gets its own subdomain under a base domain you choose (e.g. `yourdomain.com` → `todo.yourdomain.com`). The bot shows you the exact wildcard DNS record to create — with this server's IP — and verifies it live during setup. On Cloudflare, the record must be **DNS only** (grey cloud).

```bash
curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | bash
```

The installer sets up Docker (if needed), starts the Botsman daemon and reverse proxy, and asks just **two questions** in the console: your bot token (from @BotFather) and your Telegram user ID. Everything else — coding agent auth (Claude subscription or API key), domain with a live DNS check, telemetry — the bot collects **right in the Telegram chat**, with buttons and validation. Secrets pasted into the chat are deleted immediately after being saved.

Installing **as root is fine** (the typical fresh VPS): the daemon runs as root, while the coding agent and every deployed service always run as unprivileged users in their own containers.

Full setup, including the DNS wildcard record, is in [docs/install.md](docs/install.md). Полная операционная документация на русском — [docs/README.ru.md](docs/README.ru.md).

---

## Commands

| Command | What it does |
|---|---|
| `/start` | Intro and a quick how-to |
| *(free text)* | Create a new service, or change the one you're working on |
| `/list` | All your projects with status and links |
| `/status <project>` | Status, link, and the git clone URL |
| `/logs <project>` | Recent logs from the service |
| `/memory <project>` | What the agent remembers about the project (its `CLAUDE.md`) |
| `/doctor <project>` | Diagnose problems (container, DNS, TLS) with one-tap fixes |
| `/rollback <project>` | Roll back to the previous working version |
| `/setup` | Change agent auth, domain or telemetry — right in the chat |
| `/delete <project>` | Stop and remove a project (asks for confirmation) |
| `/server` `/projects` `/home` | Switch rooms (see below) |

### Talking to Botsman

There are no modes to remember — just write what you want and Botsman routes it by meaning:

- **Build** — "make a TODO app" → creates and deploys a new service.
- **Change** — "add a dark theme" → edits the service you're working on and redeploys.
- **Ask** — "how is this built?", "what's in the logs?" → answered without deploying.
- **Operate the server** — "show the load", "clean up disk", "restart todo", "redeploy todo", "update the server" → server ops. Reads run immediately; anything that changes state asks for a one-tap confirmation, and host-level actions (OS update, Botsman self-update) ask twice.

The persistent buttons below the message box are optional shortcuts: **🏠** resets the focus, **🛠 Server** shows what you can ask about the server, **📦 Projects** focuses a project so bare follow-ups ("make it bigger") land on it. Routing never depends on a mode — the same sentence means the same thing wherever you type it.

### Project memory

Each project keeps a `CLAUDE.md` at its root — the coding agent's durable memory across iterations. It's auto-loaded into the agent every run (create, edit, and questions), and the agent maintains it: what the service does, key decisions and *why*, conventions, your preferences, and "don't break X" notes. It's committed to git (so it travels with `git clone` and is restored on `/rollback`), kept concise, and scanned for secrets like any other file — only env-var **names** are ever recorded, never values. View it with `/memory <project>`; edit it by cloning the repo and pushing.

---

## Security

Botsman gives a coding agent the ability to run code and deploy services on your server. Take that seriously.

**What Botsman does to contain it:**
- Each deployed service runs in its own container, as a non-root user, with resource limits, on its own network.
- The coding agent only writes inside its own project directory. It has no access to other projects or to Botsman's config.
- Your Telegram token and Botsman's config live only in a config file (`chmod 600`) and in daemon memory — never mounted into any container, never committed to git. The LLM API key is handed only to the agent's throwaway container (it needs it to generate code) and never reaches deployed services. Per-project database credentials are injected into the service's environment only — never written into the project's git repo.
- The Telegram gateway only responds to your whitelisted account.
- Destructive actions require explicit confirmation.

**What you should do:**
- Run Botsman on a dedicated server, not alongside production systems or sensitive data — especially during early development.
- Keep your config file and server access locked down.
- Review what gets deployed before pointing real users at it.

**Reporting a vulnerability:** please report security issues privately via [SECURITY.md](SECURITY.md) rather than opening a public issue. Responsible disclosure is appreciated and credited.

This is an early project and has not yet had an external security audit. Treat it accordingly.

---

## Roadmap

Botsman is open-core. The single-user core in this repository is, and will remain, free and open source under Apache 2.0.

- **Now:** single-user core — chat → deploy on your own server, one supported service stack, git-based iteration and rollback.
- **Next:** more service stacks, web chat alongside Telegram, preview environments, better monitoring.
- **Later (separate, commercial modules — not in this repo):** team features for people who run *many* projects — project isolation across clients, roles and deploy approvals, audit logs, per-client billing, and white-label client access. These are aimed at studios and agencies and are how the project sustains itself. The core never depends on them.

If you only ever use the open core, it stays fully functional forever.

---

## Contributing

Contributions, issues, and ideas are welcome. Because Botsman runs untrusted-ish generated code on people's servers, changes touching execution, isolation, or secrets handling get extra scrutiny — please open an issue to discuss before large PRs in those areas. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Botsman core is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE).

In short: use it, modify it, run it, build on it — including commercially — with a standard patent grant for peace of mind. Future commercial team/agency modules are distributed separately under their own license and are not part of this repository.
