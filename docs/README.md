# Paco documentation

## Running an instance

- **[Self-hosting](self-hosting.md)** — installing and upgrading the native
  package, the file layout, `paco auth` and the Claude credential, what
  `apt remove` keeps versus what `apt purge` destroys, backup and restore
  (start with the `APP_SECRET` warning), who may sign in and who becomes the
  administrator, DNS/TLS/previews, disk usage and cleanup, every environment
  variable, and troubleshooting.

Installing is in the [repository README](../README.md).

## Contributing

- **[Contributing](contributing.md)** — the development setup, which stays
  Docker-based: prerequisites, running it locally, tests, the repository
  layout, and code style.

## Working on Paco

These are written for AI coding agents making changes to this codebase — and
are equally useful to a human doing the same. They describe internals, not
operation.

- [Architecture & workspace structure](agents/architecture.md) — how the web
  app, the Claude Code transport, and the sandbox fit together.
- [Code style & patterns](agents/code-style.md) — conventions, tool
  implementation patterns, dependency rules.
- [Sandbox lifecycle](agents/sandbox-lifecycle.md) — timeouts, the hibernation
  state machine, and the durable workflow that drives it.
- [Lessons learned](agents/lessons-learned.md) — failures that were expensive
  to diagnose. Add to it when you find another.

[AGENTS.md](../AGENTS.md) at the repository root is the entry point for those,
and `CLAUDE.md` is a symlink to it.
