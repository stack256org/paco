# Paco — web app

The Paco web application: a Next.js app that drives the Claude Code CLI against
Docker sandboxes. See the [repository README](../../README.md) for the full
architecture and setup, and [docs/agents/](../../docs/agents/) for contributor
guides.

## Getting started

From the repository root:

```bash
pnpm web        # start this app in development mode
```

Then open whatever `APP_URL` is set to, or `http://localhost:3000` if it is
unset — the dev server always listens on that origin's port, so the two
cannot drift apart.

## Environment variables

`.env.example` in this directory is the authoritative list. The ones a first run
cannot start without:

| Variable | Description |
| --- | --- |
| `POSTGRES_URL` | PostgreSQL connection string. The only one — Drizzle, pg-boss and the durable workflow runtime all use it. Also required for builds: migrations run during `next build`. |
| `APP_SECRET` | Signs auth sessions and derives the key that encrypts stored GitHub tokens. Any long random string; changing it invalidates both. |

Optional — a first run starts fine without these:

| Variable | Description |
| --- | --- |
| `APP_URL` | The public origin, scheme and port included. Magic-link URLs, pull-request links, better-auth's trusted origins and the port `pnpm dev` binds are all derived from it. Falls back to `http://localhost:$PORT` (default `3000`) when unset. |
| `SMTP_*` | Outbound mail for magic links. Unset means sign-in links are logged instead of emailed — enough for local development. SMTP can also be configured from **Settings** instead of the environment; a saved value there is read first. |
| `PACO_WORKSPACE_ROOT` | Relocates the sandbox workspace directory (default `~/.paco/workspaces`). |

## GitHub

GitHub access goes through the [`gh` CLI](https://cli.github.com), which must be
on the host `PATH`. Nothing GitHub-related is needed at boot: connect an account
in **Settings → GitHub**, and the token is sealed with `APP_SECRET` and stored in
the database. Cloning, pushing, creating repositories, and opening pull requests
all run through `gh` with that token supplied per-invocation in the environment.

## Quality checks

Run these from the repository root, not from this directory:

```bash
pnpm run ci      # format check, lint, typecheck, tests, migration check
```

## Further reading

- [Next.js documentation](https://nextjs.org/docs)
- [Claude Code CLI](https://code.claude.com/docs/en/overview)
