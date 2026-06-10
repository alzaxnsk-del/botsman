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
