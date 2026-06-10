# Contributing

Thanks for your interest! Issues, ideas and PRs are welcome.

## Ground rules

- **Discuss before large PRs** that touch execution, isolation, networking or
  secrets handling (the deploy engine, the agent runner, Caddy/control APIs).
  Botsman runs generated code on people's servers, so these areas get extra
  scrutiny — open an issue first.
- **Stay inside the MVP scope.** Multi-user features, billing, web UI and
  additional service stacks are deliberately out of scope for now (see the
  Roadmap in the README). Architectural cleanliness that *enables* them later
  is welcome; implementations are not.
- **Keep the single-stack contract.** Generated services are Node.js + Postgres
  behind Caddy; changes must not break the deploy contract in
  `src/agent/systemPrompt.ts`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest — must stay green
```

CI runs typecheck, tests, shell-syntax checks and a docker build on every push.
Acceptance scripts for a real VPS live in `scripts/checks/`.

## Commit style

Conventional-ish messages (`feat:`, `fix:`, `chore:`, `docs:`). Agent-generated
project commits use the `botsman:` prefix — don't use it for commits to this
repository itself.
