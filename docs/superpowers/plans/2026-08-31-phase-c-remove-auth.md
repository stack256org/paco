# Phase C: Remove Authentication and User Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Better Auth, email, and every notion of a user from Paco, leaving a single-tenant appliance whose only gate is the nginx instance password.

**Architecture:** Identity reaches the app through exactly two functions — `getServerSession()` and `getSessionFromReq()`. Both are deleted, and their ~117 call sites stop asking who the requester is rather than being handed a placeholder identity. With no user, the per-user tables and columns go, memory's user and organisation scopes collapse into one instance scope, and email — which exists only to deliver magic links and invitations — is removed entirely.

**Tech Stack:** Next.js 16 (App Router, RSC + server actions), TypeScript, Drizzle ORM + drizzle-kit, `bun test`.

**Spec:** [docs/superpowers/specs/2026-08-31-remove-auth-instance-password-design.md](../specs/2026-08-31-remove-auth-instance-password-design.md) — Phase C section.

**Depends on:** Phase A (the nginx instance password) and Phase B (public sharing removed). This branch is stacked on both. **Phase A must be present or this branch leaves the instance with no gate whatsoever.** It is; verify with `git log --oneline | grep "instance password"` before starting.

## Global Constraints

- **This is the phase that removes the only application-level authentication.** After it, nginx `auth_basic` is the entire security boundary. Nothing in this plan may add a code path that serves data without nginx in front of it.
- **No vestigial identity.** Do not replace `getServerSession()` with a stub returning a fake user. A placeholder identity is exactly what this phase exists to remove; it would leave every call site still pretending to scope by user while scoping by nothing.
- **`APP_SECRET` stays.** It no longer signs sessions, but it still derives the key sealing the stored GitHub token. Do not remove it, and do not weaken the documentation about backing it up.
- **Migrations:** after editing `apps/web/lib/db/schema.ts`, run `pnpm --dir apps/web db:generate` and commit the generated `.sql`. Never `db:push`. Never edit an existing migration — they are history.
- **The project's test suite is `pnpm test:isolated`**, which runs each file in its own process. Bare `bun test` across the repo produces ~800 spurious `Export named '…' not found` failures from module-registry pollution and is not a signal. For one file, `bun test path/to/file.test.ts` is fine.
- TypeScript style is Ultracite: double quotes, 2-space indent, no `any`, kebab-case filenames.
- Node 24 required. If `node -v` shows v22, prefix commands with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
- Quote paths containing `[` `]` in shell commands — zsh treats them as globs.
- **Writing a file is not committing it.** Verify every task with `git status --short` and `git show --stat HEAD` before reporting done. Three tasks in the preceding phases reported success for work that was unstaged or in the wrong repository.

## Reconnaissance already done (do not re-derive)

Measured on this branch's base:

| Symbol | Occurrences | Meaning |
|---|---|---|
| `getServerSession` | 111 | RSC pages and server actions |
| `getSessionFromReq` | 6 | API route handlers |
| `session?.user` / `session?.user?.id` | 49 | the guard-and-scope shape |
| `requireUserId`-style helpers | 4 | local wrappers that throw when signed out |
| `getOrganization` | 52 | **already an instance singleton — see the ruling below** |

## Ruling: `organizations` survives; `organizationMembers` and `invitations` do not

The spec lists `organizations` among the tables to drop. **That is wrong, and this plan deviates from it deliberately.**

`getOrganization()` (`apps/web/lib/org/organization.ts:24`) is `db.select().from(organizations).limit(1)`, backed by a `singleton` unique constraint. The table's columns are `id`, `name`, `singleton`, `createdAt` — **no user reference at all.** Every user linkage lives in `organizationMembers`.

So the organisation is already instance-level metadata, not an identity. Its 52 call sites already mean "this instance's organisation". Dropping it would force rewriting all 52 for no gain, while keeping it costs nothing the spec was trying to avoid — an organisation with no members is not a user identity.

**Therefore:** keep `organizations` and every `getOrganization()` call site. Drop `organizationMembers` and `invitations`, which are the genuinely multi-user parts. This honours the spec's intent ("no vestigial identity") while removing ~52 call sites of churn from this phase.

---

### Task 1: Remove email entirely

First because it is self-contained: nothing outside authentication sends mail, so this lands without touching the session seam.

**Files:**
- Delete: `apps/web/lib/email/` (6 files), `apps/web/app/api/auth/email-delivery/`, `apps/web/app/settings/admin/smtp-section.tsx`, `apps/web/app/onboarding/mail-step.tsx`
- Modify: `apps/web/lib/jobs/queue.ts` (drop `sendEmail` from `QUEUES`), `apps/web/lib/jobs/workers.ts` (drop its worker), `apps/web/lib/db/schema.ts` (drop the five `smtp*` columns from `instanceSettings`), `apps/web/lib/admin/instance-settings-actions.ts` and `-schemas.ts` (drop SMTP config and the test-email action), `apps/web/app/settings/admin/page.tsx`, `apps/web/lib/health/queue-health.ts`, `apps/web/app/settings/health/queue-card.tsx`, `apps/web/lib/auth/config.ts` (the magic-link sender), `apps/web/lib/admin/invitation-actions.ts` (the invitation sender), `apps/web/.env.example`, `packaging/debian/postinst` if it mentions `SMTP_*`
- Remove the `nodemailer` and `@types/nodemailer` dependencies from `apps/web/package.json`
- Create: the generated migration

**Interfaces:**
- Consumes: nothing.
- Produces: no mail machinery. Task 3 deletes `lib/auth/config.ts` outright; this task only removes its `sendMagicLink` body's dependency on the mailer, so leave the file compiling.

- [ ] **Step 1: Prove email has no non-auth consumer**

Run:

```bash
grep -rn "sendEmail\|buildMagicLinkEmail\|buildInvitationEmail\|isEmailDeliveryConfigured" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: every hit is in `lib/email/`, `lib/auth/config.ts`, `lib/admin/invitation-actions.ts`, `lib/admin/instance-settings-actions.ts` (a "send test email" action whose only purpose is testing the SMTP config), `lib/jobs/`, or a test of those. **If a hit appears in any feature unrelated to authentication — a notification, digest, or alert — STOP and report it.** That would mean removing email loses a real feature, which this plan asserts it does not.

- [ ] **Step 2: Delete the mail machinery**

```bash
git rm -r apps/web/lib/email apps/web/app/api/auth/email-delivery
git rm apps/web/app/settings/admin/smtp-section.tsx apps/web/app/onboarding/mail-step.tsx
```

- [ ] **Step 3: Remove the queue and its worker**

In `apps/web/lib/jobs/queue.ts`, remove `sendEmail: "send-email",` from `QUEUES`. In `apps/web/lib/jobs/workers.ts`, remove the `createQueue(QUEUES.sendEmail)` call and the worker registered on it, plus the now-unused `sendEmail`/`EmailMessage` imports.

**`fireSchedule` and the worker process itself stay.** pg-boss backs the schedules feature and is not being removed — only this one queue.

- [ ] **Step 4: Remove the SMTP settings surface**

Remove the five `smtp*` columns (`smtpHost`, `smtpPort`, `smtpSecure`, `smtpUser`, `smtpPasswordSealed` or whatever the sealed column is named — read the file) from `instanceSettings` in `apps/web/lib/db/schema.ts`. Remove the matching fields from `lib/admin/instance-settings-schemas.ts`, and the SMTP save action plus the send-test-email action from `lib/admin/instance-settings-actions.ts`. Remove the section from `app/settings/admin/page.tsx`.

In `lib/health/queue-health.ts` and `app/settings/health/queue-card.tsx`, remove the email-delivery reasoning. **Keep the queue reporting itself** — it still reports on `fireSchedule`.

- [ ] **Step 5: Sever the two senders without deleting their files**

In `apps/web/lib/auth/config.ts`, the `magicLink` plugin's `sendMagicLink` enqueues an email. Task 3 deletes this file entirely; for now, make it compile without the mailer — the simplest correct edit is to have `sendMagicLink` do nothing but the existing first-run token capture. Do not spend effort making it elegant; it is deleted in two tasks' time.

In `apps/web/lib/admin/invitation-actions.ts`, remove the `enqueue(QUEUES.sendEmail, …)` call and any now-unused imports. This file is deleted in Task 3 as well.

- [ ] **Step 6: Drop the dependency and the env documentation**

Remove `nodemailer` and `@types/nodemailer` from `apps/web/package.json`, then run `pnpm install` so the lockfile updates.

Remove the entire `SMTP_*` block from `apps/web/.env.example`. Check `packaging/debian/postinst` for `SMTP_` and remove any mention.

- [ ] **Step 7: Generate the migration**

Run: `pnpm --dir apps/web db:generate`

Read the generated `.sql`. It should drop exactly the five `smtp*` columns from `instance_settings` and nothing else. **If it proposes anything more, STOP and report.**

- [ ] **Step 8: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
grep -rn "nodemailer\|SMTP_\|smtpHost" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v migrations
```

The grep should return nothing outside migrations. Then:

```bash
git add -A && git commit -m "feat: remove email entirely"
git status --short && git show --stat HEAD
```

---

### Task 2: Delete the authentication UI and routes

**Files:**
- Delete: `apps/web/app/api/auth/` (remaining 9 files), `apps/web/components/auth/` (6), `apps/web/app/onboarding/` (remaining 4), `apps/web/app/settings/users/` (4)
- Modify: `apps/web/app/page.tsx`, `apps/web/app/layout.tsx` and any component rendering a sign-in affordance or a user menu; `apps/web/app/settings/layout.tsx` if it links to the users page

**Interfaces:**
- Consumes: nothing.
- Produces: no route or component that offers signing in. Task 3 removes the session reads these left behind.

- [ ] **Step 1: Delete the directories**

```bash
git rm -r apps/web/app/api/auth apps/web/components/auth apps/web/app/onboarding apps/web/app/settings/users
```

- [ ] **Step 2: Find what referenced them**

```bash
pnpm exec turbo typecheck --filter=web 2>&1 | grep -E "error|Cannot find" | head -40
```

Work through every error. The expected shapes are: a page importing a deleted component, `app/page.tsx` redirecting to `/onboarding`, a settings nav linking to `/settings/users`, and a layout rendering a sign-in button or user menu.

For `apps/web/app/page.tsx` specifically: it currently resolves an onboarding entry from `session?.user?.id` and redirects to `/onboarding` or `/sessions`. With no onboarding and no session, the home page should simply redirect to `/sessions`. Read `lib/instance-onboarding.ts` and delete it too if nothing else uses it.

- [ ] **Step 3: Remove the user menu**

Find whatever renders the signed-in user's name or avatar:

```bash
grep -rn "session?.user\|user.username\|extractUsername" apps/web/app/layout.tsx apps/web/components --include="*.tsx" | grep -v node_modules
```

Remove those affordances. There is no user to display.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
git add -A && git commit -m "feat: delete the authentication UI and routes"
git status --short && git show --stat HEAD
```

---

### Task 3: Remove the session seam and its call sites

The largest task. ~117 call sites, but only four shapes.

**Files:**
- Delete: `apps/web/lib/auth/` (13 files), `apps/web/lib/session/` (4 files), `apps/web/lib/admin/invitation-actions.ts`, `apps/web/lib/org/invitations.ts`
- Modify: every file importing from those

**Interfaces:**
- Consumes: Tasks 1 and 2 removed the UI and mail consumers.
- Produces: no notion of a requester. Task 4 collapses memory scopes; Task 5 drops the tables.

- [ ] **Step 1: Delete the seam**

```bash
git rm -r apps/web/lib/auth apps/web/lib/session
git rm apps/web/lib/admin/invitation-actions.ts apps/web/lib/org/invitations.ts
```

Also remove `better-auth` from `apps/web/package.json` and run `pnpm install`.

- [ ] **Step 2: Fix the call sites, by shape**

Run the typecheck and work through the errors. Every site is one of four shapes. Apply the corresponding transformation:

**Shape A — a guard that redirects or throws.**

```ts
const session = await getServerSession();
if (!session?.user) {
  redirect("/sign-in");          // or: throw new Error(SIGNED_OUT)
}
```

Delete the whole block. nginx already refused the request if the password was wrong; there is no signed-out state left to handle.

**Shape B — a guard that also scopes.**

```ts
async function requireUserId(): Promise<string> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error(SIGNED_OUT);
  }
  return session.user.id;
}
// …later:
const userId = await requireUserId();
const rows = await db.select().from(x).where(eq(x.userId, userId));
```

Delete the helper, and remove the `userId` predicate from the query — the instance has one tenant, so the unfiltered query IS the correct query. Do not substitute a constant user id.

**Shape C — passing a user id onward.**

```ts
await doSomething({ userId: session.user.id, … });
```

Remove the argument, and remove the parameter from the callee's signature. Follow the typecheck until it is gone from the whole chain.

**Shape D — displaying the user.**

```tsx
<span>{session.user.username}</span>
```

Remove the affordance. Task 2 covered the obvious ones; this catches the rest.

**When a file's ONLY purpose was scoping by user**, delete the file rather than emptying it — an empty file fails `unicorn(no-empty-file)`, which is how a dead stub survived into Phase B's final review.

- [ ] **Step 3: Prove the seam is gone**

```bash
grep -rn "getServerSession\|getSessionFromReq\|lib/auth\|lib/session\|better-auth\|SIGNED_OUT" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
pnpm test:isolated
git add -A && git commit -m "feat: remove the session seam and user scoping"
git status --short && git show --stat HEAD
```

Some tests will fail because they set up a signed-in user. Delete tests that only asserted authentication behaviour; rewrite tests that asserted a feature and merely used a session to reach it. **If a test asserts a behaviour you cannot reproduce without a user, STOP and report it** — that is a feature depending on identity, which this phase claims none do.

---

### Task 4: Collapse memory scopes

**Files:**
- Modify: `apps/web/lib/memory/paths.ts`, `load-for-turn.ts`, `org-writer.ts`, `promote.ts`, `store.ts`, `retrieve.ts` and their tests; `apps/web/app/settings/memory/`

**Interfaces:**
- Consumes: Task 3 removed the user id that `userScopeDir` took.
- Produces: two scopes — project and instance.

- [ ] **Step 1: Write the failing test**

In `apps/web/lib/memory/load-for-turn.test.ts`, rewrite the scope expectations: the loader reads **project** and **instance** scope. Replace the three-scope cases with two, keeping the existing case that project scope drops out when no `sessionRepoDir` is given — that behaviour survives.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/lib/memory/load-for-turn.test.ts`

Expected: FAIL — the loader still takes a user id and an organisation id.

- [ ] **Step 3: Collapse the paths**

In `apps/web/lib/memory/paths.ts`, replace `userScopeDir(userId)` and `orgScopeDir(organizationId)` with a single `instanceScopeDir()` returning `path.join(dataDir(), "memory", "instance")`. Keep `projectScopeDir` exactly as it is.

Nothing migrates existing memory directories. Say so in a comment: an instance upgrading from an earlier version starts with empty instance-scope memory, and the old `memory/users/` and `memory/orgs/` directories are left on disk, ignored, rather than merged — merging two users' memories into one is a decision this code cannot make correctly.

- [ ] **Step 4: Update the consumers**

`load-for-turn.ts`, `org-writer.ts` (rename it to reflect instance scope, or fold it into `store.ts` if it becomes trivial), `promote.ts`, and the memory settings page. Follow the typecheck.

- [ ] **Step 5: Run the tests and commit**

```bash
bun test apps/web/lib/memory/
pnpm exec turbo typecheck --filter=web
git add -A && git commit -m "feat(memory): collapse user and org scope into instance scope"
git status --short && git show --stat HEAD
```

---

### Task 5: Drop the user tables and columns

**Files:**
- Modify: `apps/web/lib/db/schema.ts`
- Create: the generated migration

**Interfaces:**
- Consumes: Tasks 3 and 4 removed every reader.
- Produces: a schema with no user.

- [ ] **Step 1: Prove nothing reads them**

```bash
grep -rn "userId\|user_id\|\busers\b\|authSessions\|organizationMembers\|invitations\|\baccounts\b\|verification" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v migrations
```

Expected: hits only in `apps/web/lib/db/schema.ts`. **Anything else is a surviving reader — STOP and report it.** Phase B hit exactly this: four readers of a column survived the deletion tasks and blocked the drop until they were removed.

- [ ] **Step 2: Drop the tables**

In `apps/web/lib/db/schema.ts`, delete the `users`, `organizationMembers`, `invitations`, `accounts`, `authSessions`, and `verification` table definitions.

**Keep `organizations`** — see the ruling at the top of this plan. It is instance metadata with no user reference, and 52 call sites use it.

- [ ] **Step 3: Drop the columns**

Remove `userId` and its indexes from: `githubTokens`, `sessions` (and `sessions_user_id_idx`), `chatReads`, `workflowRuns` (and `workflow_runs_user_id_idx`), `userPreferences`, `usageEvents`.

`chatReads`' primary key is `[userId, chatId]` — it becomes `chatId` alone.

Make `githubTokens` and `userPreferences` single-row instance tables using the pattern `instanceSettings` already establishes: `id: boolean("id").primaryKey().default(true)`, written with a constant row id.

- [ ] **Step 4: Generate and read the migration**

Run: `pnpm --dir apps/web db:generate`

Read the generated `.sql` in full. It should drop six tables and the listed columns, and alter two primary keys. **If it proposes dropping `organizations`, or anything not on this list, STOP and report** — that means the schema edit went further than intended.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
pnpm test:isolated
git add -A && git commit -m "feat(db): drop the user tables and columns"
git status --short && git show --stat HEAD
```

---

### Task 6: Documentation, version bump, and full verification

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/self-hosting.md`, `docs/contributing.md`, `apps/web/.env.example`, `package.json`

- [ ] **Step 1: Rewrite `AGENTS.md`'s Authentication section**

It currently opens by describing Better Auth and magic links. Replace it with: Paco has no application-level authentication. Access is controlled entirely by the nginx instance password (Phase A), and the app has no notion of a user. `APP_SECRET` remains, and still derives the key sealing the stored GitHub token — so it still must be backed up with the database.

Also fix the GitHub section: it says `lib/github/gh.ts` "pins the request to one user's token". There is one token now, and it belongs to the instance.

- [ ] **Step 2: `README.md` and `docs/self-hosting.md`**

Remove sign-up, sign-in, invitation, and mail-server material. State plainly that the instance has one password and no accounts. Keep and strengthen the `APP_SECRET` backup warning — it survives, and losing it still orphans the GitHub token.

- [ ] **Step 3: `docs/contributing.md`**

Delete the Mailpit section — there is no mail to catch. Update the setup steps: there is no account to create, so the step after `pnpm web` is simply opening the app.

- [ ] **Step 4: `.env.example`**

The `SMTP_*` block should already be gone from Task 1. Add the warning the spec requires: **a development checkout and any container run have no nginx and therefore no password at all**, so the container deployment path described in that file must not be exposed to a network.

- [ ] **Step 5: Bump the version**

In the root `package.json`, `"version": "0.4.0"` becomes `"version": "0.5.0"`.

Minor rather than major because the repo is pre-1.0 and has bumped minor for each phase. This is nonetheless the most disruptive release of the three: an operator upgrading loses every account and signs in with the instance password instead. Do not tag by hand — `release.yml` publishes on a merged version with no matching tag.

- [ ] **Step 6: Full verification**

```bash
pnpm check
pnpm exec turbo typecheck
pnpm test:isolated
```

All three must pass. `pnpm test:isolated` is the real suite; do not substitute bare `bun test`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "docs: Paco has no accounts, only an instance password"
git status --short && git show --stat HEAD
```

---

## Manual verification (human operator, on a real Debian host)

This phase cannot be signed off from the test suite alone:

- Upgrade an instance from 0.4.0 and confirm it boots, the migration applies against a populated database, and the app serves after `systemctl restart paco`.
- Confirm the browser asks for the instance password and, past it, lands directly in the app with no sign-in screen anywhere.
- Confirm GitHub still works: the stored token survives (it is sealed with `APP_SECRET`, which did not change), and `gh`-backed features still act with it.
- Confirm a chat runs end to end — the agent, the sandbox, approvals, and a preview.
- Confirm schedules still fire, proving pg-boss survived the removal of the email queue.
- Confirm memory still loads for a turn, now from project and instance scope only.
