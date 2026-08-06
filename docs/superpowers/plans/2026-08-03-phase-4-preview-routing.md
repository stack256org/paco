# Phase 4: Preview Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app the agent builds is reachable at `<slug>.<preview-domain>` over the same port Paco already owns. Previews are private by default and shareable per preview. TLS is optional, per-hostname, and needs no DNS credential.

**Architecture:** Paco already sets Docker labels when it creates a sandbox container, and Phase 3 already runs Traefik with the Docker provider and `exposedByDefault: false`. So routing is a matter of adding the right labels at container-creation time and putting the sandbox on Traefik's network. Certificates are issued **per hostname over HTTP-01** — no wildcard, no DNS provider token — which is what lets TLS be an in-product toggle instead of an install-time credential. A private preview carries a forward-auth middleware pointing at a Paco endpoint that checks the session and the preview's visibility; making one public removes the middleware.

**Tech Stack:** Traefik v3 (Docker provider), dockerode, Next.js route handlers, Drizzle + Postgres, daisyUI.

## Global Constraints

- **Never use `any`** — `unknown` plus type guards. No `.js` extensions in imports.
- Files kebab-case; types PascalCase; functions camelCase. Double quotes, 2-space indent (`pnpm fix`).
- **Zod** for validation; derive types with `z.infer`.
- **After changing `lib/db/schema.ts`**: `pnpm --dir apps/web db:generate`, then `db:migrate:apply`, then `db:check`. Never `db:push`.
- **All UI work goes through the daisyUI Blueprint MCP** — setup expert with a unique lowercase `workflowId` and absolute `projectRoot`, then the mandatory rules enforcer, then component syntax, then the quality inspector with `auditIntent: "fix_changes"` and paths **relative to projectRoot**.
- **`pnpm run ci` runs ONCE**, at the end of the phase.
- **A preview is someone's unreviewed code with access to their workspace.** Default to private. Any change that makes something reachable without a session is a security change and must be argued for, not assumed.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/db/schema.ts` (modify) | `chats.previewVisibility` — `private` \| `public` |
| `apps/web/lib/preview/hostname.ts` (create) | Derive a preview hostname from a chat id and the base domain |
| `apps/web/lib/preview/hostname.test.ts` (create) | Slug shape, base-domain handling, absence of a base domain |
| `apps/web/lib/preview/labels.ts` (create) | Build the Traefik label set for a sandbox — pure function |
| `apps/web/lib/preview/labels.test.ts` (create) | Private/public × TLS on/off, four cases |
| `packages/sandbox/docker/sandbox.ts` (modify) | Accept extra labels and a network; attach both at creation |
| `apps/web/lib/sandbox/provisioning.ts` (modify) | Pass the preview labels through when creating a sandbox |
| `apps/web/app/api/preview-auth/route.ts` (create) | Traefik forward-auth target |
| `apps/web/lib/preview/visibility.ts` (create) | Read/write a chat's preview visibility |
| `apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-control.tsx` (create) | The private/public control and the preview URL |
| `docs/self-hosting.md` (modify) | The DNS record, and what enabling TLS requires |

---

### Task 1: Preview hostnames

**Files:**
- Create: `apps/web/lib/preview/hostname.ts`, `apps/web/lib/preview/hostname.test.ts`

**Interfaces:**
- Produces:
  - `previewSlug(chatId: string): string` — a lowercase DNS-safe label derived from the chat id.
  - `previewHostname(chatId: string, baseDomain: string | null): string | null` — `null` when no base domain is configured, because there is then no hostname to route.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { previewHostname, previewSlug } from "./hostname";

describe("previewSlug", () => {
  test("is lowercase and DNS-safe", () => {
    const slug = previewSlug("Zx-WuusQjehkVpQVvoOHt");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("is stable for the same chat", () => {
    expect(previewSlug("abc123")).toBe(previewSlug("abc123"));
  });

  test("differs for different chats", () => {
    expect(previewSlug("abc123")).not.toBe(previewSlug("abc124"));
  });

  test("fits in a DNS label", () => {
    expect(previewSlug("Zx-WuusQjehkVpQVvoOHt").length).toBeLessThanOrEqual(63);
  });
});

describe("previewHostname", () => {
  test("joins the slug to the base domain", () => {
    expect(previewHostname("abc123", "previews.example.com")).toBe(
      `${previewSlug("abc123")}.previews.example.com`,
    );
  });

  test("is null when no base domain is configured", () => {
    expect(previewHostname("abc123", null)).toBeNull();
  });

  test("is null when the base domain is blank", () => {
    expect(previewHostname("abc123", "   ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/lib/preview/hostname.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Chat ids are nanoid-shaped (`Zx-WuusQjehkVpQVvoOHt`) — already unguessable, which is why the slug derives from the id rather than inventing a second secret. nanoid's alphabet includes uppercase and `_`, neither of which is valid in a DNS label, so lowercase it and replace anything outside `[a-z0-9-]` with `-`, then trim leading and trailing hyphens.

**Do not hash.** A stable, readable slug means a shared link keeps working across restarts and an operator can tell which preview a hostname belongs to. Document that reasoning in the file.

- [ ] **Step 4: Pass, then commit**

```bash
bun test apps/web/lib/preview/hostname.test.ts
git add apps/web/lib/preview
git commit -m "feat: derive a preview hostname from a chat"
```

---

### Task 2: Preview visibility

**Files:**
- Modify: `apps/web/lib/db/schema.ts`
- Create: `apps/web/lib/preview/visibility.ts`
- Create: a generated migration

**Interfaces:**
- Produces: `chats.previewVisibility` (`text`, enum `["private", "public"]`, NOT NULL, default `"private"`); `getPreviewVisibility(chatId)`, `setPreviewVisibility(chatId, visibility)`.

- [ ] **Step 1: Add the column**

On the `chats` table:

```ts
  /**
   * Who may open this chat's preview.
   *
   * Private by default, and deliberately so: a preview serves code the agent
   * has just written, from a container with the workspace mounted. Public
   * means anyone with the hostname can reach it — which is a decision the
   * owner makes per preview, not a default they inherit.
   */
  previewVisibility: text("preview_visibility", {
    enum: ["private", "public"],
  })
    .notNull()
    .default("private"),
```

- [ ] **Step 2: Generate, apply, check**

Run: `pnpm --dir apps/web db:generate`
Run: `pnpm --dir apps/web db:migrate:apply`
Run: `pnpm --dir apps/web db:check`
Expected: one `ADD COLUMN` with a default, applied, and in sync. A default makes it safe on a table that already has rows.

- [ ] **Step 3: Read/write module**

`apps/web/lib/preview/visibility.ts` — `server-only`, two functions, following the shape of `lib/settings/instance-settings.ts`. Nothing clever.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/db apps/web/lib/preview/visibility.ts
git commit -m "feat: previews are private until their owner shares them"
```

---

### Task 3: The Traefik label set

**Files:**
- Create: `apps/web/lib/preview/labels.ts`, `apps/web/lib/preview/labels.test.ts`

**Interfaces:**
- Produces: `previewLabels(input: { chatId: string; hostname: string | null; port: number; visibility: "private" | "public"; tlsEnabled: boolean; appOrigin: string }): Record<string, string>` — an empty object when `hostname` is null, because a sandbox with nowhere to be routed must not be routed.

- [ ] **Step 1: Write the failing test**

Four cases, because this is where a mistake is invisible until someone's code is on the internet:

```ts
import { describe, expect, test } from "bun:test";
import { previewLabels } from "./labels";

const base = {
  chatId: "abc123",
  hostname: "abc123.previews.example.com",
  port: 3000,
  appOrigin: "https://paco.example.com",
};

describe("previewLabels", () => {
  test("routes nothing when there is no hostname", () => {
    expect(
      previewLabels({ ...base, hostname: null, visibility: "public", tlsEnabled: true }),
    ).toEqual({});
  });

  test("a private preview carries the forward-auth middleware", () => {
    const labels = previewLabels({ ...base, visibility: "private", tlsEnabled: false });
    const joined = JSON.stringify(labels);
    expect(joined).toContain("forwardauth");
    expect(joined).toContain("/api/preview-auth");
  });

  test("a public preview carries no auth middleware", () => {
    const labels = previewLabels({ ...base, visibility: "public", tlsEnabled: false });
    expect(JSON.stringify(labels)).not.toContain("forwardauth");
  });

  test("TLS off references no certificate resolver", () => {
    const labels = previewLabels({ ...base, visibility: "private", tlsEnabled: false });
    expect(JSON.stringify(labels)).not.toContain("certresolver");
  });

  test("TLS on references the resolver", () => {
    const labels = previewLabels({ ...base, visibility: "private", tlsEnabled: true });
    expect(JSON.stringify(labels)).toContain("certresolver");
  });

  test("enabling Traefik is explicit", () => {
    const labels = previewLabels({ ...base, visibility: "private", tlsEnabled: false });
    expect(labels["traefik.enable"]).toBe("true");
  });
});
```

- [ ] **Step 2: Fail, implement, pass**

The label set: `traefik.enable=true`, a router named per chat with `Host(...)` on the `web` entrypoint (and `websecure` when TLS is on), the service port, and — when private — a `forwardauth` middleware whose `address` is `${appOrigin}/api/preview-auth` with `trustForwardHeader=true`.

`exposedByDefault: false` is already set in Traefik's static config, so `traefik.enable=true` is what opts a container in. **Deriving the label set as a pure function is the point of this task**: it is the one place where "private" can silently become "public", and a pure function is the only version of it that can be tested exhaustively.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/preview/labels.ts apps/web/lib/preview/labels.test.ts
git commit -m "feat: build a sandbox's Traefik labels from its preview settings"
```

---

### Task 4: Attach the labels and the network

**Files:**
- Modify: `packages/sandbox/docker/sandbox.ts`
- Modify: `apps/web/lib/sandbox/provisioning.ts`
- Modify: `deploy/docker-compose.yml`, `docker-compose.yml`

**Interfaces:**
- Consumes: `previewLabels` from Task 3.
- Produces: `create()` accepts optional `labels: Record<string, string>` and `network: string`, merged with the existing `paco.sandbox` labels and attached at creation.

- [ ] **Step 1: Extend the sandbox creation options**

`sandbox.ts` currently sets `Labels: { "paco.sandbox": "true", "paco.sandbox.name": config.name }`. Merge caller-supplied labels over those, and attach the container to a named network via `HostConfig.NetworkMode` or `NetworkingConfig`.

**Keep the existing published ports.** Traefik reaching the container on the shared network does not remove the operator's ability to reach a sandbox directly, and removing it would break the dev-server flow that exists today. If a later change wants to stop publishing, that is its own decision with its own reasoning.

- [ ] **Step 2: Pass the labels through**

`provisioning.ts` creates sandboxes. It must read the instance's `previewBaseDomain` and `tlsEnabled`, and the chat's `previewVisibility`, then call `previewLabels` and hand the result to `create()`.

**A sandbox is per session and a preview is per chat**, so be explicit about which id the hostname comes from and say so in a comment — getting this wrong routes one chat's preview at another chat's container.

- [ ] **Step 3: Declare the shared network**

Both compose files: an external-facing network Traefik and the sandboxes share. Traefik must be on it, or the labels resolve to a container it cannot reach and every preview 502s.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && docker compose config >/dev/null && docker compose -f deploy/docker-compose.yml config >/dev/null && echo ok`

```bash
git add packages/sandbox apps/web/lib/sandbox deploy docker-compose.yml
git commit -m "feat: route sandbox containers through Traefik"
```

---

### Task 5: Forward-auth

**Files:**
- Create: `apps/web/app/api/preview-auth/route.ts`

**Interfaces:**
- Produces: `GET /api/preview-auth` → 200 to allow, 401/403 to deny.

- [ ] **Step 1: Write it**

Traefik sends the original request's headers, notably `X-Forwarded-Host`. The handler must:

1. Read `X-Forwarded-Host` and map it back to a chat via the slug. **If it cannot, deny.** An unmappable host means the label set and the lookup disagree, and the safe answer to "I do not know whose preview this is" is no.
2. Load that chat's `previewVisibility`. Public → 200 immediately, no session needed.
3. Private → require a session and that the session's user owns the chat's session. Deny otherwise.

**Denial must not say which of those failed.** "This preview is private" is the whole message; distinguishing "no such preview" from "not yours" tells an unauthenticated caller which slugs exist.

Return 200 with an empty body on success — Traefik only reads the status.

- [ ] **Step 2: Test it**

Cover: unknown host → denied; public → allowed with no session; private with no session → denied; private with a session belonging to someone else → denied; private with the owner's session → allowed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/preview-auth
git commit -m "feat: decide who may open a preview"
```

---

### Task 6: The share control

**Files:**
- Create: `apps/web/app/sessions/[sessionId]/chats/[chatId]/preview-share-control.tsx`
- Modify: the preview panel to mount it

**Interfaces:**
- Consumes: a server action wrapping `setPreviewVisibility`.

- [ ] **Step 1: Build it (daisyUI MCP, `workflowId: "paco-preview-share"`)**

In the Preview tab: the preview URL with a copy action, and a private/public control. Requirements the copy must satisfy:

- Private is the default and is stated as such.
- Making a preview public says plainly that **anyone with the link can open it**, with no sign-in — and that it serves code the agent has just written. This is the sentence that stops someone sharing a preview of an app wired to their production database. Do not soften it.
- When no preview domain is configured, the control explains that and links to Settings instead of showing a dead URL.

- [ ] **Step 2: Audit and verify**

`daisyui_quality_inspector` with `auditIntent: "fix_changes"`. Then check it in the browser on the running dev server.

- [ ] **Step 3: Commit**

---

### Task 7: Documentation and close-out

- [ ] **Step 1: Document the DNS record**

`docs/self-hosting.md`: the operator points a **wildcard A record** `*.previews.example.com` at the server, sets the preview domain in Settings, and optionally enables TLS. Be explicit that certificates are issued **per hostname over HTTP-01**, so there is no DNS provider token and no wildcard certificate — and that the domain must already resolve before TLS is enabled, because the challenge is served over HTTP on the same host.

- [ ] **Step 2: Run the checks**

Run: `pnpm run ci`

- [ ] **Step 3: Commit**

---

## Self-Review

**Spec coverage.** The spec's Phase 4 asks for Traefik with the Docker provider driven by labels (Tasks 3–4), per-host HTTP-01 certificates rather than a wildcard (Task 3's TLS branch and Task 7's documentation), previews private by default and shareable per preview (Tasks 2, 5, 6), and hostnames derived from the chat id (Task 1). All covered.

**The risk that matters.** Task 3 is where a preview silently becomes public. That is why the label set is a pure function with a test per combination rather than a string built inline at the call site — a reviewer can read six assertions and know every case.

**Type consistency.** `previewHostname` returns `string | null` and `previewLabels` returns `{}` for a null hostname; both are consumed in Task 4, which must therefore handle "no routing" as an ordinary case rather than an error. `previewVisibility`'s enum is defined once in the schema and flows unchanged through Tasks 3, 5 and 6.

**Known gap.** Traefik's ACME HTTP-01 challenge and Phase 3's lowest-priority catch-all router have never been exercised together. Traefik gives its internal challenge router maximum priority, so it should win — but that is reasoning, not observation, and the first TLS-enabled preview is where it gets tested. The reviewer should treat it as unverified rather than settled.
