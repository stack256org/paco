# Paco documentation

## Running an instance

- **[Self-hosting](self-hosting.md)** — installing and upgrading the native
  package, the file layout, `paco auth` and the Claude credential, what
  `apt remove` keeps versus what `apt purge` destroys, backup and restore
  (start with the `APP_SECRET` warning), who may sign in and who becomes the
  administrator, DNS/TLS/previews, disk usage and cleanup, one section each
  for plugins, memory, tasks, the agent roster, design mode, schedules and the
  Poolside backend, every environment variable, and troubleshooting.
- **[Plugins](plugins.md)** — installing a plugin and granting it
  capabilities, how an inbound webhook is authenticated (and what
  `self-verified` does not enforce), and a worked example wiring up the
  first-party Slack channel plugin end to end.
- **[What the plugin sandbox contains](../packages/plugin-host/SECURITY.md)**
  — the authoritative statement of what running a third-party plugin does and
  does not expose, including the escapes earlier versions had and the Node
  >= 24 floor that backs the rest of it up.

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
