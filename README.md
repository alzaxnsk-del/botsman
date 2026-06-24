# Botsman

<img width="1536" height="1024" alt="image24061" src="https://github.com/user-attachments/assets/1956b972-2422-430e-9d09-e8f27b238c19" />


**Describe a web service in a chat message. Botsman builds it, deploys it to your own server with a real domain and HTTPS, and sends you back a working link.**

[![status: alpha](https://img.shields.io/badge/status-alpha-orange)](#early-stage)
[![license: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![chat: Telegram](https://img.shields.io/badge/chat-Telegram-26A5E4)](https://t.me/BotFather)
[![bring your own key](https://img.shields.io/badge/LLM-bring%20your%20own%20key-2ea44f)](#requirements)

Botsman runs on your VPS. You talk to it from Telegram (or push code from your laptop). A coding agent writes the service, Botsman containerizes it, gives it a subdomain with automatic TLS, runs a smoke check, and replies with a link and a screenshot. Want a change? Just say so in the chat. Your code, your server, your API key — nothing is resold or locked in.

It comes down to three "ones":

1. **One line** stands it up on your own VPS — `curl … | sudo bash`.
2. **One message** turns a description into a *live* service — code, database, subdomain, HTTPS, screenshot — at a real URL.
3. **One command** pulls it into Claude Code on your laptop; a `git push` redeploys.

Think **Replit's chat-to-app, but on your own server with your own key** — no token markup, nothing to lock you in. Or **local Claude Code without the production headache** — the domain, TLS, container and database are already wired up.

```
You:      make a TODO service with a task list and a way to mark tasks done
Botsman:  ✓ todo.yourdomain.com — deployed     [link]  [screenshot]
          What would you like to change?
You:      add a dark theme
Botsman:  ✓ Updated. Same link.
```

> ### Early stage
> ⚠️ Botsman is in active early development. Expect rough edges, breaking changes, and missing features. Do **not** run it on a server hosting anything you can't afford to lose. Read [Security](#security) before installing.

---

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Key ideas](#key-ideas)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using it](#using-it) — [talking](#how-you-talk-to-it) · [rooms & context](#rooms--context) · [commands](#slash-commands) · [memory](#project-memory)
- [Security](#security)
- [Roadmap](#roadmap)
- [Contributing](#contributing) · [License](#license)

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
- **Bring your own key.** Botsman never proxies or resells LLM tokens. You plug in your own Claude subscription or API key, and pick the model. Your bill for intelligence stays yours and transparent.
- **Phone and laptop are equal doors.** Sketch a service from Telegram on your commute, then pull it into Claude Code (or any editor) on your laptop in the evening and `git push` to ship — same project, no migration.
- **Boring, predictable deploys.** One supported service stack, containerized, with health checks and one-command rollback. Magic where it helps, predictability where it matters.

---

## Requirements

| What | Notes |
|---|---|
| **A Linux VPS** | Ubuntu 22.04 / 24.04, 2 vCPU / 4 GB RAM, ports 80 + 443 open |
| **A domain** | with a **wildcard DNS record** `*.yourdomain.com → <server IP>` (the bot shows you the exact record and checks it live) |
| **A Telegram bot** | token from [@BotFather](https://t.me/BotFather) + your user ID from [@userinfobot](https://t.me/userinfobot) |
| **Coding-agent auth** | either a **Claude subscription** (`claude setup-token` → `sk-ant-oat…`, no extra bills) **or** an **Anthropic API key** ([console.anthropic.com](https://console.anthropic.com), pay-per-use) |

---

## Quick start

**1. Point a wildcard DNS record at your server.** An A-record with host `*` → your server's IP, so `anything.yourdomain.com` resolves to it. On Cloudflare, set it to **DNS only** (grey cloud) — the proxy breaks Let's Encrypt. Verify: `dig +short anything.yourdomain.com` → your server IP. (The setup wizard checks this for you too.)

**2. Install.**

```bash
curl -fsSL https://raw.githubusercontent.com/alzaxnsk-del/botsman/main/install.sh | sudo bash
```

The installer sets up Docker (if needed), starts the daemon + reverse proxy, and asks just **two questions** in the console: your bot token and your Telegram user ID.

**3. Finish in the chat.** Open Telegram, send your bot `/start`, and it walks you through the rest with buttons and live validation:

- **Coding agent** — Claude subscription or API key (the secret is deleted from the chat the moment it's saved);
- **Model** — 🏆 Opus (best) / ⚖️ Sonnet / ⚡ Haiku, changeable anytime via `/setup`;
- **Domain** — it shows the exact DNS record (with your server's IP) and checks it live;
- **Telemetry** — one tap, off by default.

Then describe your first service. Installing **as root is fine** — the daemon runs as root, but the coding agent and every deployed service always run as unprivileged users in isolated containers.

> Full walkthrough (DNS, config reference, uninstall) → [docs/install.md](docs/install.md).

---

## Using it

### How you talk to it

There are no modes to remember — write what you want, and Botsman routes it by meaning:

| You say… | Botsman… |
|---|---|
| "make a TODO app" | **builds** and deploys a new service |
| "add a dark theme" | **changes** the service you're working on and redeploys |
| "how is this built?", "what's in the logs?" | **answers** — without deploying |
| "change the domain to landing", "смени домен на shop" | **re-points the project** to a new subdomain (asks first), re-issues TLS |
| "show the load", "clean up disk", "restart todo", "update the server" | runs **server ops** |

You don't have to type everything: **attach a spec document** (`.md`, `.txt`, source, JSON) and Botsman builds or changes from it, or **send a UI mockup or a screenshot of a bug** and the coding agent uses the image as a visual reference. A caption, if you add one, is your instruction.

Server reads (metrics, logs, diagnosis) run immediately; anything that changes state asks for a one-tap confirmation, and host-level actions (OS update, Botsman self-update) ask twice.

**Botsman never silently guesses.** If a message could be a new project or a change to an existing one — or it's unclear which project — it **asks with buttons** ("Change 📦 todo? · 🆕 New project") instead of acting. Before building something whose name resembles an existing project, it checks with you first.

### Rooms & context

The persistent buttons below the message box change with where you are — and they're command-driven, so they keep working even if the AI is unreachable (out of quota, network hiccup):

- **🏠 Home** — a control panel: a status line (live projects, anything down, AI-router health, startup warnings) and one-tap buttons — **📊 Server status · 📦 Projects · ⬆️ Update Botsman · 🔧 Setup · 💻 Code on your computer**. To start a new project, just describe it right here.
- **📦 Connect to a project** (tap one under **📦 Projects**, or say "go to todo") — while connected, every change and question goes straight to it, and the bar becomes project actions: **🔍 Review** (a read-only code pass), **📋 Logs**, **↩️ Rollback** (asks first), **🌐 Domain** (move it to another subdomain of your base, e.g. `landing.yourdomain.com`), **💻 Claude Code** (a ready clone + `claude` + `git push` guide). Tap **🚪 Exit** to disconnect.
- **🛠 Server** — admin mode: ask in plain language ("show load", "clean up disk", "update the server"), with one-tap buttons for the common ones. Server reads run immediately; state changes confirm once, host-level actions twice.

Outside a connection, routing is by content and anything ambiguous is confirmed first. The keyboards are an additional reliable surface, not a mode wall — and because taps are deterministic, Home and the room actions work even when the LLM router is down (it tells you so, and points you to Home).

### Slash commands

| Command | What it does |
|---|---|
| `/start` | Intro and a quick how-to |
| *(free text)* | Create a service, change one, ask a question, or run a server op |
| `/list` | All your projects with status and links |
| `/status <project>` | Status, link, and the git clone URL |
| `/logs <project>` | Recent logs from the service |
| `/memory <project>` | What the agent remembers about the project |
| `/doctor <project>` | Diagnose container / DNS / TLS, with one-tap fixes |
| `/rollback <project>` | Roll back to the previous working version |
| `/delete <project>` | Stop and remove a project (asks for confirmation) |
| `/setup` | Change agent auth, model, domain or telemetry |
| `/version` | The running version and release date |

### Project memory

Each project keeps a `CLAUDE.md` at its root — the coding agent's durable memory across iterations. It's auto-loaded into the agent on every run (create, edit, and questions), and the agent maintains it: what the service does, key decisions and *why*, conventions, your preferences, and "don't break X" notes.

It's committed to git (so it travels with `git clone` and is restored on `/rollback`), kept concise, and scanned for secrets like any other file — only env-var **names** are recorded, never values. View it with `/memory <project>`; edit it by cloning the repo and pushing.

### From your editor

Connect to a project and tap **💻 Claude Code** (or run `/status <project>`) to get a ready-to-paste clone command — Botsman fills in your server's public IP, the repo path, and the SSH user it infers from the install path. Clone it, edit on your laptop or in Claude Code, and `git push` — Botsman redeploys automatically and tells you in the chat. Agent commits are prefixed `botsman:`; yours are not.

---

## Security

Botsman gives a coding agent the ability to run code and deploy services on your server. Take that seriously.

**What Botsman does to contain it:**

- Each deployed service runs in its own container, as a non-root user, with resource limits, on its own network.
- The coding agent runs in a throwaway container with only its project directory mounted — no access to other projects, the Docker socket, or Botsman's config.
- Your Telegram token and Botsman's config live only in a `chmod 600` file and in daemon memory — never mounted into any container, never committed to git. The LLM key is handed only to the agent's container and never reaches deployed services. Per-project database credentials are injected into the service's environment only.
- The Telegram gateway only responds to your whitelisted account. Destructive actions require explicit confirmation.

**What you should do:**

- Run Botsman on a dedicated server, not alongside production systems or sensitive data — especially during early development.
- Keep your config file and server access locked down.
- Review what gets deployed before pointing real users at it.

> **Note:** the in-chat DevOps assistant can update the host OS and Botsman itself via a privileged container — full root on the host, reachable only from your owner account behind a double confirmation. Details and threat model in [SECURITY.md](SECURITY.md).

**Reporting a vulnerability:** please report security issues privately (see [SECURITY.md](SECURITY.md)) rather than opening a public issue. This is an early project with no external security audit yet — treat it accordingly.

---

## Roadmap

Botsman is open-core. The single-user core in this repository is, and will remain, free and open source under Apache 2.0.

- **Now** — single-user core: chat → deploy on your own server, one supported service stack, git-based iteration and rollback.
- **Next** — more service stacks, web chat alongside Telegram, preview environments, better monitoring.
- **Later** *(separate commercial modules, not in this repo)* — team features for people running *many* projects: client isolation, roles and deploy approvals, audit logs, per-client billing, white-label access. Aimed at studios and agencies, and how the project sustains itself. The core never depends on them.

If you only ever use the open core, it stays fully functional forever.

---

## Contributing

Contributions, issues, and ideas are welcome. Because Botsman runs untrusted-ish generated code on people's servers, changes touching execution, isolation, or secrets handling get extra scrutiny — please open an issue to discuss before large PRs in those areas. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Botsman core is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE). Use it, modify it, run it, build on it (including commercially) with a standard patent grant. Future commercial team/agency modules are distributed separately under their own license and are not part of this repository.
