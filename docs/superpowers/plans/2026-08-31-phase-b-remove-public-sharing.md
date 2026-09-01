# Phase B: Remove Public Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove public preview sharing entirely, so a preview is gated by the instance password like everything else, and the per-chat visibility apparatus disappears.

**Architecture:** Preview nginx server blocks stop delegating to `auth_request → /api/preview-auth` and instead carry the same `auth_basic` pair as the main site. With no preview able to be public, the whole authorization apparatus — the route, the grant cookie, the visibility column, and the share UI — has nothing left to decide and is deleted rather than rewritten.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Drizzle ORM + drizzle-kit migrations, nginx config generation, `bun test`.

**Spec:** [docs/superpowers/specs/2026-08-31-remove-auth-instance-password-design.md](../specs/2026-08-31-remove-auth-instance-password-design.md) — Phase B section.

**Depends on:** Phase A ([2026-08-31-phase-a-instance-password.md](2026-08-31-phase-a-instance-password.md)), which established the `auth_basic` pair and `/etc/nginx/paco.htpasswd`. This branch is stacked on it.

## Global Constraints

- **The `auth_basic` pair is exactly two lines, byte-identical to the main site's** (`packaging/debian/postinst`):
  ```nginx
  auth_basic "Paco";
  auth_basic_user_file /etc/nginx/paco.htpasswd;
  ```
  A drift between the two files means previews and the app disagree about which password protects them.
- **Never widen access.** At no point in this plan may a preview become reachable without a password. If a step would leave a window where `auth_request` is gone but `auth_basic` is not yet present, reorder it.
- **`previewServerBlock` is a pure function and must stay one.** No database, no `server-only`, no I/O — that purity is what lets its test cover every hostname × TLS combination exhaustively.
- **Hostname and certificate-path validation must survive untouched.** `assertSafeHostname` and the `certDir` character check are injection guards on text that becomes executed nginx configuration. They have nothing to do with auth and must not be removed alongside it.
- **Migrations:** after editing `apps/web/lib/db/schema.ts`, always run `pnpm --dir apps/web db:generate` and commit the generated `.sql` alongside. Never `db:push`.
- TypeScript style is Ultracite: double quotes, 2-space indent, no `any`, kebab-case filenames. Tests are `bun test`.
- Node 24 is required. If `node -v` reports v22, prefix commands with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

## Reconnaissance already done (do not re-derive)

- `apps/web/lib/preview/preview-grant.ts` appears in `grep` hits for `lib/crypto/secret-box.ts`, `app/api/internal/approvals/route.ts` and `lib/plugins/tools-token.ts`. **These are comment references, not imports.** Deleting the module breaks no code, but leaves three comments pointing at a file that no longer exists; Task 3 fixes them.
- `PreviewShareControl` is rendered from exactly one place: `apps/web/app/sessions/[sessionId]/chats/[chatId]/workspace-panel.tsx:216`, behind an `isPreview` check, with its import at line 20.
- `apps/web/proxy.test.ts` tests **only** the `/shared` rewrite, so the whole file goes with the feature.
- `apps/web/lib/preview/actions.ts` exposes exactly two visibility functions: `getPreviewShareState` (line 71) and `updatePreviewVisibility` (line 93).

---

### Task 1: Previews use the instance password instead of `auth_request`

Done first, and alone, because it is the step that keeps previews protected. Every later task removes something this step makes unnecessary.

**Files:**
- Modify: `apps/web/lib/preview/nginx-config.ts` — `previewServerBlock` and the module header comment
- Modify: `apps/web/lib/preview/nginx-config.test.ts`

**Interfaces:**
- Consumes: the `auth_basic` pair established by Phase A's `packaging/debian/postinst`.
- Produces: preview server blocks with no `auth_request` and no `/_paco_auth` location. Task 3 deletes `/api/preview-auth` on the strength of nothing calling it any more.

- [ ] **Step 1: Write the failing test**

In `apps/web/lib/preview/nginx-config.test.ts`, replace the assertions that expect `auth_request` and the `/_paco_auth` location with these. Keep every existing hostname-validation and port-validation test exactly as it is — those cover the injection guards, not auth.

```ts
  test("requires the instance password", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: null,
    });

    expect(block).toContain('auth_basic "Paco";');
    expect(block).toContain("auth_basic_user_file /etc/nginx/paco.htpasswd;");
  });

  test("no longer delegates authorization to the app", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: null,
    });

    // The app no longer decides preview access: there is no public preview to
    // decide about, so nginx answers with the instance password alone.
    expect(block).not.toContain("auth_request");
    expect(block).not.toContain("_paco_auth");
    expect(block).not.toContain("preview-auth");
  });

  test("requires the password on the TLS listener too", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: "/etc/paco/preview-certs/abc123.previews.example.com",
    });

    expect(block).toContain('auth_basic "Paco";');
    expect(block).toContain("auth_basic_user_file /etc/nginx/paco.htpasswd;");
    expect(block).not.toContain("auth_request");
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test apps/web/lib/preview/nginx-config.test.ts`

Expected: the three new tests FAIL — the generated block still contains `auth_request` and `location = /_paco_auth`, and contains no `auth_basic`. Pre-existing hostname/port tests still PASS.

- [ ] **Step 3: Swap the auth mechanism in `previewServerBlock`**

In `apps/web/lib/preview/nginx-config.ts`, delete the `location = /_paco_auth { ... }` block and the `auth_request /_paco_auth;` directive from the generated template, and add the two `auth_basic` lines inside the `server { ... }` block, immediately after the `server_name` line.

`appPort` becomes unused by the template once the auth subrequest is gone. **Keep the parameter and keep `assertValidPort(appPort, "appPort")`** — removing it would change this function's signature and every caller, which is not this task's job; leave a comment saying it is retained deliberately and that Phase C may remove it.

- [ ] **Step 4: Rewrite the module header comment**

The header comment documents four properties of the `auth_request` design and a known gap about `redirectToGrant`. Properties 1-3 and the gap describe machinery being deleted. **Property 4 does not** — it is the injection guard on hostnames interpolated into generated nginx config, and it survives.

Replace the four-property list and the "One known gap" paragraph with:

```text
 * Two properties matter, both lessons the Traefik version paid for:
 *
 * 1. Access is decided by nginx, from the instance password, and nothing
 *    else. Previews used to be individually public or private, authorized
 *    per request by `/api/preview-auth`; that apparatus is gone along with
 *    public sharing, and a preview is now exactly as reachable as the rest
 *    of the instance. The `auth_basic` pair below must stay byte-identical
 *    to the one the package writes for the main site — two files disagreeing
 *    about which password guards this host is the failure to avoid.
 * 2. The hostname is validated before it is ever interpolated into generated
 *    config text. It comes from `previewSlug(chatId)` plus a configured base
 *    domain, so it should always be safe — but nginx config is executed as
 *    configuration, and "should" is not a guarantee. This guard is unrelated
 *    to authentication and must outlive every change to it.
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `bun test apps/web/lib/preview/nginx-config.test.ts`

Expected: PASS, all tests including the pre-existing hostname and port cases.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/preview/nginx-config.ts apps/web/lib/preview/nginx-config.test.ts
git commit -m "feat(preview): gate previews with the instance password"
```

---

### Task 2: Remove the share UI

Done before the server route so the UI stops calling an endpoint while it still exists, rather than after it disappears.

**Files:**
- Delete: `apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-view.tsx`
- Delete: `apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-view.test.tsx`
- Delete: `apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-control.tsx`
- Delete: `apps/web/app/sessions/[sessionId]/chats/[chatId]/use-preview-share.ts`
- Modify: `apps/web/app/sessions/[sessionId]/chats/[chatId]/workspace-panel.tsx` — remove the import (line 20) and the render (line 216)
- Modify: `apps/web/lib/preview/actions.ts` — remove `getPreviewShareState` and `updatePreviewVisibility`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no caller of `/api/preview-auth/grant` or of the visibility server actions. Task 3 deletes the route; Task 4 drops the column.

- [ ] **Step 1: Delete the four UI files**

```bash
git rm "apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-view.tsx" \
       "apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-view.test.tsx" \
       "apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-control.tsx" \
       "apps/web/app/sessions/[sessionId]/chats/[chatId]/use-preview-share.ts"
```

Paths are quoted because `[sessionId]` is a glob pattern in zsh — this is the rule recorded in `AGENTS.md`, and an unquoted path fails with "no matches found".

- [ ] **Step 2: Unwire it from the workspace panel**

In `apps/web/app/sessions/[sessionId]/chats/[chatId]/workspace-panel.tsx`, remove the `import { PreviewShareControl } from "./preview-share-control";` line and the `{isPreview ? <PreviewShareControl chatId={chatId} /> : null}` line.

Check whether `isPreview` still has another use in that file. If it does, leave it; if this was its only consumer, remove its declaration too — an unused variable fails lint.

- [ ] **Step 3: Remove the visibility server actions**

In `apps/web/lib/preview/actions.ts`, delete `getPreviewShareState` and `updatePreviewVisibility` along with any imports they alone required (notably from `./visibility`). Leave every other export in that file untouched.

- [ ] **Step 4: Verify nothing still references the deleted surface**

Run:

```bash
grep -rn "PreviewShareControl\|PreviewShareView\|usePreviewShare\|getPreviewShareState\|updatePreviewVisibility" apps/web --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: no output. Any hit is a dangling reference that must be removed before committing.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec turbo typecheck --filter=web`

Expected: PASS. This is the check that catches a missed import; the test suite alone would not.

- [ ] **Step 6: Commit**

```bash
git add -A "apps/web/app/sessions" apps/web/lib/preview/actions.ts
git commit -m "feat(preview): remove the public-sharing UI"
```

---

### Task 3: Delete the preview authorization apparatus

**Files:**
- Delete: `apps/web/app/api/preview-auth/route.ts`, `route.test.ts`, `grant/route.ts`, `grant/route.test.ts`
- Delete: `apps/web/lib/preview/decide-access.ts`, `decide-access.test.ts`, `visibility.ts`, `preview-grant.ts`, `preview-grant.test.ts`, `authorize.ts`
- Modify: `apps/web/lib/crypto/secret-box.ts` (comment ~line 67), `apps/web/app/api/internal/approvals/route.ts` (comment ~line 77), `apps/web/lib/plugins/tools-token.ts` (comments ~lines 19 and 42)

**Interfaces:**
- Consumes: Task 1 removed the only nginx caller of `/api/preview-auth`; Task 2 removed the only UI caller of the grant route.
- Produces: nothing. This is pure deletion.

- [ ] **Step 1: Delete the routes and modules**

```bash
git rm -r apps/web/app/api/preview-auth
git rm apps/web/lib/preview/decide-access.ts \
       apps/web/lib/preview/decide-access.test.ts \
       apps/web/lib/preview/visibility.ts \
       apps/web/lib/preview/preview-grant.ts \
       apps/web/lib/preview/preview-grant.test.ts \
       apps/web/lib/preview/authorize.ts
```

- [ ] **Step 2: Fix the three comments that now point at a deleted file**

These are comments, not imports — nothing breaks at build time, which is exactly why they would otherwise rot unnoticed. Each cites `preview-grant.ts` as a worked example of a scoped, signed cookie. Rewrite each to make its point without the dead reference:

- `apps/web/lib/crypto/secret-box.ts` (~line 67) — the sentence about `lib/preview/preview-grant.ts` signing a preview-scoped cookie with a separate secret. Keep the point about key separation; drop the citation.
- `apps/web/app/api/internal/approvals/route.ts` (~line 77) — same treatment.
- `apps/web/lib/plugins/tools-token.ts` (~lines 19 and 42) — two references, one describing the pattern it mirrors and one about key separation. `tools-token.ts` is now the surviving example of that pattern, so state the property directly rather than pointing at a sibling.

- [ ] **Step 3: Verify nothing references the deleted modules**

Run:

```bash
grep -rn "preview-auth\|decide-access\|decidePreviewAccess\|preview-grant\|previewGrant\|preview/visibility\|preview/authorize" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Typecheck and test**

Run: `pnpm exec turbo typecheck --filter=web` then `bun test apps/web/lib/preview/`

Expected: both PASS. The preview directory's remaining tests (hostname, nginx-config, nginx-reload, reconcile-job) must still be green.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/app/api apps/web/lib/preview apps/web/lib/crypto/secret-box.ts apps/web/lib/plugins/tools-token.ts
git commit -m "feat(preview): delete the preview authorization apparatus"
```

---

### Task 4: Drop the `previewVisibility` column

Last of the code-removal tasks, because a column cannot be dropped while anything still reads it.

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — remove `previewVisibility` from the `chats` table (~line 378)
- Create: the generated migration under `apps/web/lib/db/migrations/` (drizzle-kit names it)

**Interfaces:**
- Consumes: Tasks 2 and 3 removed every reader and writer of the column.
- Produces: nothing.

- [ ] **Step 1: Confirm nothing reads the column**

Run:

```bash
grep -rn "previewVisibility\|preview_visibility" apps/web packages --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "lib/db/migrations"
```

Expected: exactly one hit, the definition in `apps/web/lib/db/schema.ts`. Existing migration files legitimately mention it — they are history and are never edited. If anything else appears, stop and report: a reader survived Tasks 2-3.

- [ ] **Step 2: Remove the column from the schema**

In `apps/web/lib/db/schema.ts`, delete the `previewVisibility` column definition from the `chats` table, including its `enum: ["private", "public"]` and any comment attached to it.

- [ ] **Step 3: Generate the migration**

Run: `pnpm --dir apps/web db:generate`

Expected: a new `.sql` file appears under the migrations directory containing an `ALTER TABLE ... DROP COLUMN` for `preview_visibility`. Read it and confirm that is all it does — if it proposes dropping anything else, stop and report, because that means the schema and the migration journal had drifted before this change.

- [ ] **Step 4: Typecheck**

Run: `pnpm exec turbo typecheck --filter=web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/lib/db/migrations
git commit -m "feat(db): drop the preview visibility column"
```

---

### Task 5: Remove the dead `/shared` proxy rewrite

**Files:**
- Modify: `apps/web/proxy.ts`
- Delete: `apps/web/proxy.test.ts`

**Interfaces:** none in either direction.

- [ ] **Step 1: Confirm the rewrite target does not exist**

Run: `find apps/web/app/api -ipath "*shared*"`

Expected: no output. `proxy.ts` rewrites `/shared/:id` to `/api/shared/:id/markdown`, and no such route was ever built — so this matcher is dead code and removing it costs no working feature. If the command DOES print a path, stop and report: the route exists after all and this task's premise is wrong.

- [ ] **Step 2: Reduce `proxy.ts` to a no-op**

`proxy.ts` is Next 16's renamed middleware. Its only behaviour is the `/shared` rewrite, and its `config.matcher` names only `/shared/:path*`.

Replace the file's contents with a proxy that matches nothing, keeping the export shape Next requires:

```ts
import { type NextRequest, NextResponse } from "next/server";

/**
 * Next's middleware entry point (renamed `proxy` in Next 16).
 *
 * Deliberately inert. It previously rewrote `/shared/:id` to a markdown
 * route for public share links; public sharing is gone, and the route it
 * rewrote to never existed in the first place. The file remains because
 * Next resolves it by convention and a future rewrite belongs here.
 *
 * `matcher: []` means this never runs — cheaper than matching every request
 * to do nothing.
 */
export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
```

- [ ] **Step 3: Delete its test**

`apps/web/proxy.test.ts` tests only the `/shared` rewrite, so it goes with the feature:

```bash
git rm apps/web/proxy.test.ts
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec turbo typecheck --filter=web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/proxy.ts && git commit -m "chore: remove the dead /shared proxy rewrite"
```

---

### Task 6: Documentation, version bump, and full verification

**Files:**
- Modify: `README.md`, `docs/self-hosting.md` — remove public-preview/sharing claims
- Modify: `AGENTS.md` — the preview description
- Modify: `package.json` — version to `0.4.0`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Find every claim that previews can be public**

Run:

```bash
grep -rn -i "public preview\|preview.*public\|share.*preview\|publicly" README.md docs/ AGENTS.md | grep -v superpowers
```

Fix each hit so it describes what is now true: a preview is reachable by anyone who has the instance password, and by nobody else. There is no per-chat public/private toggle and no shareable public link. Do not simply delete the sentences — a reader looking for "how do I share a preview?" needs to find the answer, which is now "give them the instance password, or do not share it".

The `docs/superpowers/` directory is excluded above on purpose: specs and plans are historical records of decisions and are never retro-edited.

- [ ] **Step 2: Update `AGENTS.md`**

Its preview description should now say previews are protected by the instance password via `auth_basic`, generated per chat by `lib/preview/nginx-config.ts`, with no per-chat visibility and no authorization subrequest.

- [ ] **Step 3: Bump the version**

In the root `package.json`, change `"version": "0.3.0"` to `"version": "0.4.0"`.

Minor again: this removes a user-visible feature (public sharing) but nothing an operator's install depends on structurally. `.github/workflows/release.yml` publishes on a merged version with no matching tag, so this is what makes the merge cut a release. Do not tag by hand.

- [ ] **Step 4: Run the full check**

Run: `pnpm check` then `pnpm exec turbo typecheck` then `pnpm test:isolated`

Note `pnpm test:isolated` — NOT bare `bun test`. This repo runs each test file in its own process because a single shared process pollutes the module registry and produces hundreds of spurious `Export named '…' not found` failures. `bun test` across the whole repo is not a meaningful signal here.

Expected: format clean, typecheck 8/8, all isolated test files pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs AGENTS.md package.json
git commit -m "docs: previews are gated by the instance password"
```

---

## What Phase B deliberately does not do

- **Better Auth stays.** The app still has sign-in; Phase C removes it. Previews are now gated by nginx while the app is gated by both.
- **`appPort` stays in `previewServerBlock`'s signature** even though the template no longer uses it. Changing that signature is Phase C's business, if at all.
- **Existing preview nginx files on a live host are not rewritten by this change alone.** `syncPreviewRoutes` regenerates them on its next sweep. The manual verification below must confirm that actually happens.

## Manual verification (human operator, on a real Debian host)

Nothing here can be checked by the automated suite:

- A chat with a running preview: open its hostname in a fresh browser profile and confirm it prompts for the instance password and refuses a wrong one.
- Confirm previously-public previews are no longer reachable without the password — that is the security-relevant half of this change.
- Confirm `/etc/paco/nginx/*.conf` files generated before this upgrade are rewritten with `auth_basic` by the reconcile sweep, and that `nginx -t` passes afterwards.
- Confirm `paco tls <domain>` on a preview hostname still produces a working TLS block that carries the `auth_basic` pair.
