# Remove authentication; protect the instance with one password

**Date:** 2026-08-31
**Status:** Approved in brainstorming; awaiting implementation planning
**Prior spec:** [2026-08-25-paco-platform-design.md](2026-08-25-paco-platform-design.md)

## Context

Paco authenticates with Better Auth: magic-link sign-in, a `users` table, an
organisation and invitation model, per-user GitHub tokens, per-user memory,
and a first-run flow that promotes the first account to administrator. The
whole apparatus exists to answer "which of several people is this?"

That question no longer needs answering. Paco is deployed as a single-tenant
appliance: one operator, one box, one instance. The identity model is
carrying weight nobody is standing on — an entire sign-in surface, six
database tables, thirteen `userId` columns and roughly 105 call sites — and
it is the reason a self-hosted install has a mail server to configure before
anyone can log in at all.

This design removes authentication entirely and replaces it with a single
instance password enforced by nginx, set during installation and rotated from
the CLI.

**There are no existing installs and no existing users.** Every migration in
this document is therefore a plain `DROP` with no backfill, no data-preserving
heuristic, and no upgrade warning. That is a deliberate simplification licensed
by the current deployment reality, and it is the single largest reason this
design is tractable. If that ceases to be true before implementation lands,
this document must be revisited: it has no answer for an instance with two
users' GitHub tokens in it.

## Decisions taken in brainstorming

| Question | Decision |
|---|---|
| What happens to per-user data? | Rip out user scoping entirely — no vestigial identity |
| Where is the password enforced? | nginx `auth_basic` only |
| What about public previews and `/shared`? | Drop public sharing as a product feature |
| No-TTY install? | Generate a password, print it in the summary |
| Basic-auth username? | Fixed: `paco` |
| Email? | Removed entirely, as part of Phase C |
| Delivery? | All three phases, sequenced A → B → C |

## Architecture

```text
Browser ──► nginx [auth_basic: /etc/paco/htpasswd] ──► 127.0.0.1:3000 Next app
                                                        no session, no user,
                                                        single implicit tenant

<slug>.<base> ──► nginx [auth_basic, same file] ──► sandbox container:PORT
                   no auth_request, no /api/preview-auth

secret:   /etc/paco/htpasswd          root:www-data 0640, bcrypt
set by:   paco password [--stdin]     the only implementation
seeded:   packaging/debian/postinst   generates one if absent
prompted: install.sh                  TTY prompts; no TTY prints the generated one
```

`APP_SECRET` **stays.** It no longer signs sessions, but it still derives the
key that seals the stored GitHub token, so its backup significance and the
warnings about it in `docs/self-hosting.md` remain accurate and must not be
softened.

## Phasing, and why the order is load-bearing

Three bodies of work ship in this order:

- **A — Instance password.** nginx `auth_basic`, `paco password`, install prompt.
- **B — Remove public sharing.** Preview visibility, `/api/preview-auth`, `/shared`.
- **C — Remove auth and user scoping.** Better Auth, six tables, all `userId` columns.

**A → B → C is a security requirement, not a preference.** C removes the only
thing currently protecting a Paco instance. Landing C before A leaves the box
unauthenticated on the public internet for the entire window between the two.
A goes first so the instance is always behind *something*.

B sits between them because it is what makes C's simplification legal. Once no
preview can be public, `decidePreviewAccess` has no decision left to make and
the whole `auth_request` subrequest apparatus deletes itself rather than
needing to be rewritten against a userless world.

## Phase A — the instance password

### `paco password`

One implementation, in `scripts/paco`; everything else calls it.

```text
paco password           prompt twice, echo off, requires root and a TTY
paco password --stdin   read the password from stdin (scripts, install.sh)
```

Writes `/etc/paco/htpasswd` as `root:www-data`, mode `0640` — readable by
nginx's worker user, by nobody else.

The password is hashed with `htpasswd -iB`. Two constraints decide that exact
form:

- **`-i` reads from stdin.** `htpasswd -b` takes the password as an argument,
  and `ps` shows one process's arguments to every user on the machine. This is
  the same rule `AGENTS.md` already states for `gh` tokens, and it applies here
  for the same reason.
- **`-B` is bcrypt.** nginx reads bcrypt (`$2y$`) htpasswd entries.
  `openssl passwd` cannot produce them, which is why `apache2-utils` becomes a
  package dependency rather than this being done with tools already present.

**No `systemctl reload` afterwards.** nginx reads `auth_basic_user_file` per
request, so a new password takes effect immediately. Credentials cached by a
browser start receiving 401s and it re-prompts on its own — that is the
re-authentication, and it is why this design needs no logout.

On success the command removes `/etc/paco/initial-password` if present: once
the operator has set their own password, the generated one is not a fact about
the system any more.

### `packaging/debian/postinst` owns the invariant

postinst ensures `/etc/paco/htpasswd` always exists. If it is absent it
generates a strong random password, writes it, and records it in
`/etc/paco/initial-password` (`0600 root:root`) for `install.sh` to report.

This exists because `apt-get install paco` is a supported entry point on its
own, without `install.sh`. An nginx site whose `auth_basic_user_file` points
at a missing file does not fail `nginx -t` — the file is only opened at
request time — so the failure surfaces as a 500 on every request instead of a
password prompt. postinst guarantees the file exists; `install.sh` only ever
refines what is in it.

The nginx server block in postinst gains:

```nginx
auth_basic "Paco";
auth_basic_user_file /etc/paco/htpasswd;
```

**A pre-existing bug surfaces here and is fixed in passing.** `postinst`
writes `$NGINX_SITE` unconditionally on every install *and* every upgrade,
but the file it writes declares "this file is never regenerated once it
exists" and invites the operator to "Edit freely". The code and the comment
contradict each other, and an operator who accepts that invitation loses
their edits at the next `apt upgrade`.

The unconditional write is the behaviour worth keeping — it is what
guarantees the `auth_basic` directives land on every existing install rather
than only on fresh ones, and for a security control that is the property we
want. The comment is what is wrong, and it gets corrected to describe what
the script actually does.

### `install.sh`

Gains `--password` and `PACO_PASSWORD`, mirroring the existing `--domain` and
`PACO_DOMAIN` pair exactly.

- **With a TTY:** prompt for the password with echo disabled, prompt again to
  confirm, re-prompt on mismatch, then pipe it into `paco password --stdin`.
- **Without a TTY:** do not block. The advertised install is
  `curl -fsSL … | sudo sh`, which has no terminal; a `read` here would hang it
  forever. This is the trap `install.sh` already documents for the domain
  prompt, and the guard is the same `[ -t 0 ]` test. Leave postinst's generated
  password in place and print it in the final summary.

The closing summary prints the username `paco` and — **only when the password
was generated rather than typed** — the password itself, plus the command to
change it. A password the operator chose is never echoed back to the terminal.

`paco status` reports whether the instance is still using its generated
password, so "I never set one" is discoverable rather than silent.

### Package dependency

`apache2-utils` joins `Depends` in `packaging/debian/control`.

## Phase B — remove public sharing

Deletions, with no replacement:

- `previewVisibility` column on `chats` (`lib/db/schema.ts`), and the
  public/private toggle in the chat UI.
- `app/api/preview-auth/**` — the route, its `grant/` subroute, and both test
  files.
- `lib/preview/decide-access.ts`, `lib/preview/visibility.ts`,
  `lib/preview/preview-grant.ts`, and their tests.
- The `/shared/:path*` matcher and markdown rewrite in `apps/web/proxy.ts`.
  **This is dead code:** the rewrite targets `/api/shared/<id>/markdown`, and
  no such route exists in the tree. Removing it costs no working feature.

`previewServerBlock` in `lib/preview/nginx-config.ts` loses its
`location = /_paco_auth` block and its `auth_request` directive, and gains the
same `auth_basic` pair as the main site. Previews become gated by the instance
password instead of by chat ownership.

That file's header comment documents four hard-won properties of the
`auth_request` design and a known gap around `redirectToGrant`. When the
apparatus goes, the comment goes with it — but the *reasons* for properties 3
and 4 (resolving a preview hostname back to a chat; validating a hostname
before interpolating it into generated nginx config) survive independently and
must be preserved in whatever comment replaces it. Property 4 in particular is
an injection guard, not an artefact of auth.

`nginx-config.test.ts` is exhaustive over hostname × TLS combinations and gets
rewritten against the new expected output.

## Phase C — remove authentication and user scoping

### Code deleted

`lib/auth/**` (config, client, actions, first-run, first-run-token-capture,
signup-policy, bootstrap-admin, username, sign-in-failure-copy),
`lib/session/**`, `app/api/auth/**`, `components/auth/**`, the first-run
onboarding flow under `app/onboarding`, `app/settings/users`, and the
magic-link half of `lib/email/mailer.ts`.

`better-auth` is dropped from `apps/web/package.json`.

### Schema

Tables dropped: `users`, `organizations`, `organizationMembers`,
`invitations`, `accounts`, `authSessions`, `verification`.

`userId` columns dropped, with their indexes: `githubTokens`, `sessions`
(and `sessions_user_id_idx`), `chatReads`, `workflowRuns` (and
`workflow_runs_user_id_idx`), `userPreferences`, `usageEvents`.

`githubTokens` and `userPreferences` become single-row instance-level tables,
following the singleton pattern `instanceSettings` already establishes:
`id: boolean("id").primaryKey().default(true)` written with a constant row id.
Folding both into `instanceSettings` outright was considered and rejected —
`githubTokens` has its own columns and lifecycle (`githubUserId`, scopes,
sealed value), and merging them buys one fewer table at the cost of a much
larger refactor.

`chatReads` loses `userId` from its composite primary key, leaving `chatId`
alone as the key.

Migrations are generated with `pnpm --dir apps/web db:generate` and the `.sql`
committed alongside the schema change, per `AGENTS.md`.

### Email

Email is removed entirely — the mail server, the SMTP settings, and the
delivery machinery.

This is a pure deletion with no feature loss, which is worth stating because
it is not obvious. Paco sends exactly three kinds of mail, and all three exist
only to serve authentication:

1. The magic link (`lib/auth/config.ts`).
2. The invitation (`lib/admin/invitation-actions.ts`).
3. A "test email" (`lib/admin/instance-settings-actions.ts`) whose only
   purpose is verifying the SMTP configuration that exists for the other two.

With sign-in and invitations gone, nothing is left to send. There is no
notification, digest, or alert feature that would be quietly lost.

Deleted: `lib/email/**` (mailer, smtp-config, invitation-email, escape-html
if it has no other consumer), the `nodemailer` dependency, the
`app/settings/admin/smtp-section.tsx` panel, the mail step of the onboarding
flow, `app/api/auth/email-delivery`, and the SMTP columns on
`instanceSettings` (`smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, and the
sealed `smtpPassword`). The `SMTP_*` variables leave `.env.example`, and
`packaging/debian/postinst` stops mentioning them.

**pg-boss stays.** Only the `sendEmail` queue is removed from `QUEUES`; the
`fireSchedule` queue backs the schedules feature and is untouched, as is the
worker process that serves it. `lib/health/queue-health.ts` loses its
email-delivery reasoning but keeps its queue reporting.

### Memory scopes

Memory is stored on disk, not in Postgres. `lib/memory/paths.ts` resolves
three scopes: project (`<repo>/.paco/memory`), user
(`<PACO_HOME>/memory/users/<userId>`) and organisation
(`<PACO_HOME>/memory/orgs/<orgId>`).

User and organisation scope both lose their meaning. They collapse into one
instance scope at `<PACO_HOME>/memory/instance`, leaving two scopes: project
and instance. `load-for-turn.ts`, `org-writer.ts`, `promote.ts` and their
tests change accordingly. Nothing migrates existing memory directories —
there is no existing instance whose memory would be stranded.

### Call sites

Roughly 105 files reference `lib/auth`, `getSession`, `auth.api`, or a
current user. They all reach identity through two functions —
`getServerSession()` in `lib/session/get-server-session.ts` and
`getSessionFromReq()` in `lib/session/server.ts` — which is the seam that
makes this tractable. Both are deleted; call sites stop asking who the
requester is rather than being handed a placeholder identity. A stub user
returned from a surviving helper would be the "vestigial identity" this
design exists to avoid, and is explicitly rejected.

## Testing

TDD applies to the TypeScript throughout. Tests for deleted modules are
deleted with them; tests for changed behaviour are rewritten before the
change:

- `lib/preview/nginx-config.test.ts` — new expected server-block output (B).
- `lib/memory/load-for-turn.test.ts` — two scopes instead of three (C).
- Every test asserting on sign-in, invitations, signup policy, or admin
  bootstrap is deleted (C).

The shell has no test harness today: `install.sh` and `scripts/paco` are
POSIX sh with no coverage. Phase A adds a small one — a `bun test` file that
runs `paco password --stdin` and `install.sh --dry-run` against a temporary
root and asserts on the files produced, their modes, and the hash format.

This is new infrastructure rather than an extension of something existing,
and it was flagged as such during brainstorming; the alternative offered was
manual verification on a throwaway container. Approval was given for the
design as a whole without singling this out, so the harness is in scope. It
is the one item here most reasonable to cut if the plan needs trimming.

## Consequences accepted

Two properties of the nginx-only enforcement decision cannot be fixed inside
this design and are recorded rather than hidden:

1. **A dev checkout and any container run have no nginx, and therefore no gate
   at all.** After C, `pnpm web` serves an unauthenticated Paco. This is fine
   for local development, but it means the container deployment path described
   in `apps/web/.env.example` stops being safe to expose to a network. The
   documentation must say so plainly.
2. **There is no logout and no in-app password change.** Rotation is
   `sudo paco password`, and every browser re-prompts once its cached
   credentials start failing. This was raised and accepted: re-authentication
   after a password change is the intended behaviour.

## Documentation to update

- `README.md` — the sign-in description, and the sandbox/preview section.
- `docs/contributing.md` — step 6 and the sign-in loop; the Mailpit section is
  deleted outright, since there is no mail to catch.
- `docs/self-hosting.md` — sign-ups, the auth model, `APP_SECRET`'s remaining
  role, the mail-server section, and the new `paco password` command.
- `apps/web/.env.example` — the whole `SMTP_*` block is removed, and the
  container-deployment note gains the warning from Consequences (1).
- `AGENTS.md` — the Authentication section is replaced; the GitHub section's
  "pins the request to one user's token" wording no longer describes a
  multi-user system.
