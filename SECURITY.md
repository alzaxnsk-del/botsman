# Security Policy

Botsman runs a coding agent and the services it generates on your own server,
so security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting instead: on the repository page,
go to **Security → Report a vulnerability** (this opens a private advisory
visible only to the maintainers).

You can expect an acknowledgement within a few days. Responsible disclosure is
appreciated and will be credited in the release notes unless you prefer
otherwise.

## Scope notes

- The single supported deployment model is one owner, one VPS. Multi-tenant
  hardening is explicitly out of scope for the current alpha.
- The threat model and the isolation measures (agent containers, per-project
  networks, unix-socket admin API, token-protected control API) are described
  in the Security section of the README.
- The project is in alpha and has not had an external security audit yet.

## Privileged host execution (DevOps room)

The in-chat **Server (DevOps)** room can run host-level operations — host
metrics, `apt upgrade`, Botsman self-update. Because the daemon runs in a
container, these spawn a one-off container with `Privileged: true` and
`PidMode: 'host'` that `nsenter`s into the host's PID 1. **That container is
effectively root on the host** and deliberately punctures the isolation the
rest of Botsman maintains (agent and service containers drop all capabilities).

This is gated by, in order:
- **Owner whitelist** — only the configured Telegram IDs are served at all.
- **Room boundary** — host exec is reachable only from the DevOps room.
- **Confirm buttons** — every mutating op requires a tap; host-level ops
  (`host_update`, `self_update`) require a **second** confirmation.
- **No model-emitted shell** — the LLM only selects an op id from a fixed
  catalog (`src/gateway/devops.ts`); the actual command is assembled by
  Botsman's code in `src/hostExec.ts`. Free-form shell is never executed.
- **Audit log** — every host-exec invocation is logged with its command.

If you do not want this capability, you can stay out of the DevOps room; a
future release may add a config flag to disable host-level ops entirely.
