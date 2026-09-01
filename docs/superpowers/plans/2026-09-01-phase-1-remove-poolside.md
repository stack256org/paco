# Phase 1: Remove Poolside Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Poolside backend and every user-facing affordance that existed only because Paco had two backends, leaving Claude Code as the sole implementation behind an unchanged `@paco/agent-backend` seam.

**Architecture:** Pure deletion, in dependency order — the UI stops offering a choice, then the factory stops constructing one, then the package goes, then the schema drops what nothing reads any more. The `@paco/agent-backend` interface and the `chats.backend` column both survive: they are what `fake-backend.ts` and `conformance.ts` test against.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Drizzle ORM + drizzle-kit, POSIX sh (`scripts/paco`), `bun test`.

**Spec:** [docs/superpowers/specs/2026-09-01-byo-claude-credential-design.md](../specs/2026-09-01-byo-claude-credential-design.md) — Phase 1.

## Global Constraints

- **`@paco/agent-backend` and `chats.backend` SURVIVE.** Only the Poolside implementation goes. The interface is what `packages/agent-backend/fake-backend.ts` and `conformance.ts` test against, and the column is threaded through `resumeTokens` and the roster. Deleting the seam is explicitly out of scope.
- **This phase adds nothing.** Every step removes. If a step seems to need a new capability, the plan is wrong — STOP and report rather than inventing one.
- **An empty file fails lint** (`unicorn(no-empty-file)`). If removing content empties a file, delete the file.
- **No dangling references** — in code *or* comments. Comments citing deleted files are a rot pattern this repo has been bitten by three times.
- **Migrations:** after editing `apps/web/lib/db/schema.ts`, run `pnpm --dir apps/web db:generate` and commit the generated `.sql`. Never `db:push`; never edit an existing migration.
- **The suite is `pnpm test:isolated`** (one process per file). Bare `bun test` across the repo yields ~800 spurious `Export named '…' not found` failures from module-registry pollution and is not a signal. `bun test <one file>` is fine.
- TypeScript style is Ultracite: double quotes, 2-space indent, no `any`, kebab-case filenames. Quote paths containing `[` `]` in shell commands — zsh treats them as globs.
- Node 24 required. If `node -v` shows v22, prefix with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.
- **Writing a file is not committing it.** Verify each task with `git status --short` and `git show --stat HEAD`.

## Reconnaissance already done (do not re-derive)

- `packages/poolside-backend` holds 17 files. **53 further files** reference Poolside across `apps/web` and `packages`.
- `apps/web/package.json:27` declares `"@paco/poolside-backend": "workspace:*"`. Nothing else in `pnpm-workspace.yaml` or the root `package.json` names it.
- `apps/web/lib/agent/backend-factory.ts` defines `ChatBackendId = "claude-code" | "poolside"` and constructs both.
- Schema surface: `chats.backend` enum `["claude-code", "poolside"]`; `instanceSettings.poolsideBaseUrl`, `poolsideApiKeySealed`, `poolsideBinaryPath`.
- `scripts/paco` holds `auth_poolside()`, `poolside_binary()`, `poolside_credentials_file()`, `poolside_state()`, plus usage text and a `poolside` dispatch arm.
- `docs/self-hosting.md` has a dedicated §18 plus scattered references at roughly lines 309, 313, 346, 350, 365, 368, 532, 603, 1218.

---

### Task 1: Stop offering a backend choice in the UI

First, because everything downstream is only reachable through these affordances.

**Files:**
- Delete: `apps/web/components/backend-selector-compact.tsx`
- Delete: `apps/web/app/settings/agents/roster-backend-support.ts` and `roster-backend-support.test.ts`
- Delete: `apps/web/app/settings/agents/roster-backend-notice.test.tsx`
- Delete: `apps/web/app/sessions/[sessionId]/chats/[chatId]/unviewable-image-notice.tsx` and `unviewable-image-notice.test.tsx`
- Modify: `apps/web/app/sessions/[sessionId]/chats/[chatId]/model-effort-backend-controls.tsx` and its test, `session-chat-content.tsx`, `apps/web/app/settings/agents/agents-page-content.tsx`, `apps/web/components/model-option-list.tsx` and its test, `model-selector-compact.tsx`, `apps/web/components/provider-icons.tsx`, `apps/web/lib/model-provider-groups.ts` and its test

**Interfaces:**
- Consumes: nothing.
- Produces: no UI path that names a backend. Task 2 removes the factory that served them.

- [ ] **Step 1: Establish what each deletion costs**

Before deleting, read each of these and confirm it exists *only* to distinguish backends:

```bash
grep -n "poolside\|backend" "apps/web/components/backend-selector-compact.tsx" \
  "apps/web/app/settings/agents/roster-backend-support.ts" \
  "apps/web/app/sessions/[sessionId]/chats/[chatId]/unviewable-image-notice.tsx" | head -20
```

`unviewable-image-notice.tsx` exists because Poolside cannot view images; Claude Code can, so the notice can never fire once Poolside is gone. `roster-backend-support.ts` answers "does this roster agent work on this backend", which has one answer now. **If any of them turns out to carry behaviour unrelated to backend choice, STOP and report it** rather than deleting that behaviour along with the rest.

- [ ] **Step 2: Delete the backend-only components**

```bash
git rm apps/web/components/backend-selector-compact.tsx \
       apps/web/app/settings/agents/roster-backend-support.ts \
       apps/web/app/settings/agents/roster-backend-support.test.ts \
       apps/web/app/settings/agents/roster-backend-notice.test.tsx \
       "apps/web/app/sessions/[sessionId]/chats/[chatId]/unviewable-image-notice.tsx" \
       "apps/web/app/sessions/[sessionId]/chats/[chatId]/unviewable-image-notice.test.tsx"
```

- [ ] **Step 3: Let the typechecker find the callers**

Run: `pnpm exec turbo typecheck --filter=web`

Work through every error. Expected shapes: a component importing a deleted one; `model-effort-backend-controls.tsx` rendering the backend selector; `agents-page-content.tsx` rendering the roster notice; `session-chat-content.tsx` rendering the unviewable-image notice.

Remove the render and the import. Where a prop existed only to feed a deleted component, remove the prop and follow the typechecker to its callers.

- [ ] **Step 4: Collapse the single-provider groupings**

`apps/web/lib/model-provider-groups.ts` groups models by provider, and `apps/web/components/provider-icons.tsx` renders a per-provider icon. With one provider, a grouped list is a list.

Read both. If `model-provider-groups.ts` has no remaining caller once the picker stops grouping, delete it and its test; if it retains a use, reduce it to the single group. Same judgement for `provider-icons.tsx`: delete it if the Claude icon has no other consumer, otherwise keep just that icon.

Record which you chose and why in your report — this is the one judgement call in this task.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
bun test apps/web/components/ apps/web/app/settings/agents/
git add -A apps/web && git commit -m "feat: stop offering a backend choice in the UI"
git status --short && git show --stat HEAD
```

---

### Task 2: Remove the Poolside settings surface and the factory arm

**Files:**
- Delete: `apps/web/app/settings/models/poolside-provider-section.tsx` and `poolside-provider-section.test.tsx`
- Delete: `apps/web/lib/admin/poolside-connection-test.test.ts` and whatever module it tests
- Modify: `apps/web/app/settings/models/page.tsx`, `apps/web/lib/agent/backend-factory.ts` and its test, `apps/web/lib/agent/backend-capabilities.ts` and its test, `apps/web/lib/admin/instance-settings-actions.ts`, `instance-settings-schemas.ts` and its test, `apps/web/lib/settings/instance-settings.ts` and its test

**Interfaces:**
- Consumes: Task 1 removed the UI that reached these.
- Produces: `ChatBackendId = "claude-code"`. Task 3 deletes the package this stopped constructing.

- [ ] **Step 1: Delete the settings section**

```bash
git rm apps/web/app/settings/models/poolside-provider-section.tsx \
       apps/web/app/settings/models/poolside-provider-section.test.tsx \
       apps/web/lib/admin/poolside-connection-test.test.ts
```

Then find and delete the module `poolside-connection-test.test.ts` covered:

```bash
grep -rn "poolside-connection-test\|poolsideConnectionTest\|testPoolsideConnection" apps/web --include="*.ts" --include="*.tsx" | grep -v node_modules
```

- [ ] **Step 2: Narrow the backend id**

In `apps/web/lib/agent/backend-factory.ts`, change:

```ts
export type ChatBackendId = "claude-code" | "poolside";
```

to:

```ts
/**
 * The backends a chat can run on.
 *
 * One member today. The union — and the `@paco/agent-backend` interface it
 * selects — are kept deliberately: they are what `fake-backend.ts` and
 * `conformance.ts` test against, and what a future second backend would slot
 * into. A single-member union costs nothing and states the seam is real.
 */
export type ChatBackendId = "claude-code";
```

Remove the `PoolsideBackend` import, its construction arm, and the `"poolside"` entry from any backend list in that file.

- [ ] **Step 3: Remove the Poolside settings fields**

From `apps/web/lib/admin/instance-settings-schemas.ts`, `instance-settings-actions.ts` and `apps/web/lib/settings/instance-settings.ts`, remove the `poolsideBaseUrl`, `poolsideApiKey`/`poolsideApiKeySealed` and `poolsideBinaryPath` fields, their validation, their save actions and their read paths.

**Do not touch `apps/web/lib/db/schema.ts` yet** — dropping the columns is Task 4, after every reader is gone.

- [ ] **Step 4: Verify nothing constructs or configures Poolside**

```bash
grep -rn "PoolsideBackend\|poolsideBaseUrl\|poolsideApiKey\|poolsideBinaryPath\|buildPoolsideBackendConfig" apps/web --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "lib/db/schema.ts"
```

Expected: no output. Hits in `schema.ts` are expected and are Task 4's.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
bun test apps/web/lib/agent/ apps/web/lib/admin/ apps/web/lib/settings/
git add -A apps/web && git commit -m "feat: remove the Poolside settings surface and factory arm"
git status --short && git show --stat HEAD
```

---

### Task 3: Delete the package

**Files:**
- Delete: `packages/poolside-backend/` (17 files)
- Modify: `apps/web/package.json:27`
- Modify: `apps/web/lib/model-catalog.ts` and its test, `apps/web/lib/agent/run-step.ts` and its test, `apps/web/app/workflows/chat.ts` and its test, `apps/web/app/api/models/route.ts` and its test, and any remaining importer the typechecker names

**Interfaces:**
- Consumes: Tasks 1-2 removed the UI and the factory.
- Produces: no `@paco/poolside-backend` in the workspace. Task 4 drops the schema.

- [ ] **Step 1: List every remaining importer**

```bash
grep -rn "@paco/poolside-backend" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Every hit must be removed in this task. `model-catalog.ts` imports `POOLSIDE_MODEL_IDS`; remove `POOLSIDE_MODELS`, the `ALL_MODELS` concatenation that merges it with `CLAUDE_MODELS`, and reduce `ALL_MODELS` to `CLAUDE_MODELS`.

- [ ] **Step 2: Delete the package and its dependency**

```bash
git rm -r packages/poolside-backend
```

Remove the `"@paco/poolside-backend": "workspace:*",` line from `apps/web/package.json`, then run `pnpm install` so the lockfile updates. If pnpm refuses with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, re-run with `CI=true` — it wants to purge `node_modules` and cannot prompt.

- [ ] **Step 3: Fix the importers**

Run `pnpm exec turbo typecheck --filter=web` and work through every error.

For `run-step.ts`, `chat.ts` and `api/models/route.ts`: these branch on backend to choose behaviour. With one backend the branch has one arm — inline it rather than leaving a conditional whose alternative cannot occur, and delete any now-unreachable helper.

- [ ] **Step 4: Verify the package is gone**

```bash
grep -rn "poolside" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "lib/db/schema.ts"
ls packages/poolside-backend 2>&1
```

Expected: no output from the grep (schema hits excepted), and `No such file or directory` from `ls`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
pnpm test:isolated
git add -A && git commit -m "feat: delete the Poolside backend package"
git status --short && git show --stat HEAD
```

---

### Task 4: Drop the Poolside schema

**Files:**
- Modify: `apps/web/lib/db/schema.ts`
- Create: the generated migration under `apps/web/lib/db/migrations/`

**Interfaces:**
- Consumes: Tasks 1-3 removed every reader.
- Produces: a schema with one backend value and no Poolside columns.

- [ ] **Step 1: Confirm nothing reads them — STOP CONDITION**

```bash
grep -rn "poolside\|Poolside" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v migrations
```

Expected: hits **only** in `apps/web/lib/db/schema.ts`. **Anything else is a surviving reader — STOP and report it.** This exact failure happened in an earlier phase of this project: four readers of a column survived the deletion tasks and blocked the drop.

- [ ] **Step 2: Edit the schema**

Remove `poolsideBaseUrl`, `poolsideApiKeySealed` and `poolsideBinaryPath` from `instanceSettings`, with their comments.

Narrow the `chats.backend` enum from `["claude-code", "poolside"]` to `["claude-code"]`. **Keep the column.** Update its doc comment — it currently explains the two-value choice and the `claude-code → poolside → claude-code` round trip, which no longer exists. Say instead that the column records which backend ran a chat's turns, that there is one today, and that it is retained as the seam rather than as a live choice.

- [ ] **Step 3: Generate and read the migration**

Run: `pnpm --dir apps/web db:generate`

Read the generated `.sql` in full. It should drop three `instance_settings` columns and alter the `chats.backend` enum constraint, and nothing else. **If it proposes dropping `chats.backend` itself, or touching any other table, STOP and report** — that means the schema edit went further than intended.

Note an enum narrowing can fail on existing rows holding the removed value. Check whether the generated SQL handles that; if it does not, and a row could hold `'poolside'`, the migration needs a `UPDATE chats SET backend='claude-code' WHERE backend='poolside';` before the constraint change. State in your report which case applies and what you did.

- [ ] **Step 4: Verify and commit**

```bash
pnpm exec turbo typecheck --filter=web
pnpm test:isolated
git add -A && git commit -m "feat(db): drop the Poolside columns and enum value"
git status --short && git show --stat HEAD
```

---

### Task 5: Remove the Poolside CLI surface, packaging and docs

**Files:**
- Modify: `scripts/paco` — `usage()`, `auth_poolside()`, `poolside_binary()`, `poolside_credentials_file()`, `poolside_state()`, `cmd_auth()`, `cmd_status()`, the dispatch
- Modify: `apps/web/.env.example` — the `POOLSIDE_*` documentation
- Modify: `docs/self-hosting.md` — §18 and the references near lines 309, 313, 346, 350, 365, 368, 532, 603, 1218
- Modify: `install.sh` if it names Poolside

**Interfaces:** consumes everything above; produces no operator-facing mention of Poolside.

- [ ] **Step 1: Remove the CLI functions**

In `scripts/paco`, delete `auth_poolside()`, `poolside_binary()`, `poolside_credentials_file()` and `poolside_state()`.

**`paco auth` itself survives this phase** — it still runs `claude auth login`, and removing it is Phase 2's job. Reduce `cmd_auth` to the Claude path only, and remove the `poolside` argument from it and from `usage()`.

In `cmd_status`, remove the `Poolside:` row.

- [ ] **Step 2: Check the shell still parses**

```bash
sh -n scripts/paco && echo "sh -n OK"
command -v dash >/dev/null && dash -n scripts/paco && echo "dash -n OK"
sh scripts/paco --help | grep -ci poolside
sh scripts/paco status | head -6
```

The grep must print `0`. `status` must still run and print its rows without a `Poolside:` line.

- [ ] **Step 3: Remove the env documentation**

In `apps/web/.env.example`, delete the `POOLSIDE_API_KEY` / `POOLSIDE_STANDALONE_BASE_URL` block and the sentence in the backend description that offers Poolside as an alternative.

- [ ] **Step 4: Remove the documentation**

Delete §18 of `docs/self-hosting.md` in full and every scattered reference. Renumber the sections that follow, and check every cross-reference to a renumbered section still points at the right one:

```bash
grep -n "§1[0-9]\|§2[0-9]" docs/self-hosting.md | head -20
```

Do not simply delete sentences that mention Poolside as one of two options — rewrite them to describe the one that remains. A reader should not be able to tell a second backend was removed; they should read a document about a product with one.

- [ ] **Step 5: Verify no operator-facing mention survives**

```bash
grep -rn -i "poolside\|'pool'" scripts/paco install.sh packaging/ docs/*.md apps/web/.env.example 2>/dev/null | grep -v superpowers
```

Expected: no output. `docs/superpowers/` is excluded on purpose — specs and plans are historical records and are never retro-edited.

- [ ] **Step 6: Commit**

```bash
git add -A scripts docs apps/web/.env.example install.sh packaging
git commit -m "docs: remove the Poolside CLI surface and documentation"
git status --short && git show --stat HEAD
```

---

### Task 6: Version bump and full verification

**Files:** `package.json`

- [ ] **Step 1: Bump the version**

In the root `package.json`, change `"version": "0.5.0"` to `"version": "0.6.0"`.

Minor: this removes a backend some installs may use, but nothing structural to an operator on Claude Code. `.github/workflows/release.yml` publishes on a merged version with no matching tag; do not tag by hand.

- [ ] **Step 2: Full verification**

```bash
pnpm check
pnpm exec turbo typecheck
pnpm test:isolated
```

All three must pass. `pnpm test:isolated` is the real suite — do not substitute bare `bun test`.

- [ ] **Step 3: Commit**

```bash
git add package.json && git commit -m "chore: 0.6.0"
git status --short && git show --stat HEAD
```

---

## Manual verification (human operator)

- `sudo paco status` prints no `Poolside:` row and still reports unit, version, domain, password and Claude state.
- `sudo paco auth` still authenticates Claude Code (it is removed in Phase 2, not this one).
- An upgrade over an instance that had Poolside configured applies the migration and starts; a chat that previously ran on Poolside still opens, with its history intact, and new turns run on Claude Code.
