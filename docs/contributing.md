# Contributing

The development setup for Paco. If you want to run an instance rather than
change its code, see the [repository README](../README.md) and
[self-hosting.md](self-hosting.md) instead — this document is for working on
the codebase itself.

## Why development still uses containers

Paco installs in production as a native `.deb`: Postgres and nginx are host
packages, and the app itself runs under systemd (see the README and
[self-hosting.md](self-hosting.md)). Development did not follow it there, and
that is deliberate rather than an oversight.

A contributor's database should be disposable — created, migrated, and thrown
away without touching anything else on the machine, and identical whether
you're on macOS, Linux, or CI. A container is the lower-friction choice for
that; nobody should have to install and configure a system Postgres just to
run the test suite. Production optimizes for the opposite property: an
operator's data has to survive indefinitely across upgrades, and a host
package managed by the same `apt`/`systemctl` tooling as everything else on
the box is easier to trust with that than a Docker volume is — the old
Compose deployment's sharpest edge was exactly a volume that could get
silently detached from the state that depended on it.

One thing is a container in both places, unaffected by any of this: the
**sandbox**, the per-chat container an agent actually runs its work in. That's
core to the architecture, not a deployment detail — see
[docs/agents/architecture.md](agents/architecture.md) — and there is no native
equivalent of it. A self-hosted instance always needs Docker for sandboxes;
only *Paco's own* deployment mechanism changed.

## Prerequisites

- Node.js 24
- pnpm 11 (via Corepack)
- Docker — for the local Postgres container below and for the sandbox image
- Postgres 17 (the container below is the quickest way to get one)
- The [Claude Code CLI](https://code.claude.com/docs/en/setup) on `PATH` —
  Paco drives it directly with a credential from Settings, not through a
  login session, so there is nothing to sign it in to ahead of time
- The [GitHub CLI](https://cli.github.com) (`gh`), for anything GitHub-related

## Setup

```bash
corepack enable
pnpm install

# 1. Start Postgres. Any Postgres 17 will do; this is the quickest.
docker run -d --name paco-postgres \
  -e POSTGRES_USER=paco -e POSTGRES_PASSWORD=paco -e POSTGRES_DB=paco \
  -p 55432:5432 postgres:17

# 2. Configure. Edit apps/web/.env and set these three values —
#    POSTGRES_URL must match the database above, and APP_URL is
#    commented out by default but worth uncommenting locally: it keeps
#    Paco off :3000, which is also the port sandboxed dev servers
#    usually claim first.
cp apps/web/.env.example apps/web/.env
#   POSTGRES_URL=postgres://paco:paco@localhost:55432/paco
#   APP_SECRET=$(openssl rand -hex 32)
#   APP_URL=http://localhost:3066

# 3. The sandbox image every chat runs inside. Optional: Paco pulls the
#    published one on first use, so skip this unless you are changing the
#    image itself. Tag a local build as the name Paco asks for — the pull only
#    happens when nothing is there under that tag.
docker build -t ghcr.io/stack256org/paco-sandbox:latest packages/sandbox/docker

# 4. Create the schema. This applies the migrations and the workflow tables.
#    If it prints "POSTGRES_URL not set — skipping", your .env is not being
#    read: fix that before continuing.
pnpm --dir apps/web db:migrate:apply

# 5. Run it.
pnpm web
```

Before your first chat, add a Claude credential: open **Settings → Models**
and paste in an API key, or a setup token from running `claude setup-token`
on your own machine against a Claude subscription. It is stored sealed in
your local Postgres (with the `APP_SECRET` from step 2) and read fresh on
every turn — there is no CLI login session to sign in to.

> **A development checkout has no password.** The instance password is
> enforced by nginx, which only the `.deb` install sets up — so `pnpm web`
> serves an unprotected Paco. That is fine on localhost and is the only
> supported unprotected configuration; do not expose it to a network.

Open <http://localhost:3066> (or <http://localhost:3000> if you left `APP_URL`
commented out). There is no account to create and nothing to sign in to —
Paco has no application-level authentication, so the page you land on is the
app itself.

GitHub is connected instance-wide, from **Settings → Connections** — see the
README for how that works. It needs `gh` on `PATH`; nothing else to
configure.

## Repository layout

```text
apps/web                Next.js app, durable workflows, auth, chat UI
packages/claude-code    Claude Code CLI transport: options, process, protocol,
                        UI stream, approval policy and hook
packages/sandbox        Sandbox interface, Docker implementation, worktree
                        layout, git helpers, skill discovery
packages/shared         Shared UI utilities
packages/tsconfig       Shared TypeScript configs
packaging/              The native .deb: systemd unit, maintainer scripts,
                        build-deb.sh — see self-hosting.md, not this file
```

See [docs/agents/architecture.md](agents/architecture.md) for how the pieces
fit together, and [docs/agents/](agents/) generally — it is written for AI
coding agents working in this codebase, and is equally useful to a human
doing the same.

## Quality checks

```bash
pnpm check                              # lint + format check
pnpm fix                                # lint + format fix
pnpm typecheck                          # typecheck every package
bun test path/to/file.test.ts           # the one test file you're touching — fast, use while iterating
bun test                                # the whole suite
pnpm run ci                             # format, lint, typecheck, and the full suite — run this once, when a task is finished, not after every edit
```

Tests that need Docker or the `claude` CLI skip themselves automatically when
those aren't available.

Run project checks through these package scripts rather than invoking
`oxlint`/`tsc`/etc. directly (`pnpm exec ...`), so a local run matches what CI
does.

## Code style

- **pnpm exclusively** for dependency management; Node 24 for utility
  scripts, Bun for tests.
- **Files** kebab-case, **types** PascalCase, **functions** camelCase.
- **Never use `any`** — use `unknown` and narrow with type guards.
- No `.js` extensions in imports.
- **Ultracite** (oxlint + oxfmt) formatting: double quotes, 2-space indent.
- **Zod** schemas for validation; derive types with `z.infer`.
- Prefer a new colocated file for a distinct concern (component, hook,
  utility, schema, data-access helper) over growing an existing one — see
  [AGENTS.md](../AGENTS.md#file-organization--separation-of-concerns) for the
  full rule.

The full conventions, tool-implementation patterns, and dependency rules are
in [docs/agents/code-style.md](agents/code-style.md); [AGENTS.md](../AGENTS.md)
at the repository root is the entry point for all of the agent-facing docs and
covers authentication, GitHub, sessions/chats/worktrees, and tool approval in
more depth than this file does.

## Git

When bringing in `origin/main`, prefer a normal merge (`git fetch origin main`
then `git merge origin/main`) over rebasing, unless asked otherwise.

File paths containing brackets (Next.js dynamic routes like `[id]`) are
glob patterns to zsh — quote them in git commands:

```bash
git add "apps/web/app/tasks/[id]/page.tsx"
```
