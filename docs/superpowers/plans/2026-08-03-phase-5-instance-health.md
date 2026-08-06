# Phase 5: Instance Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One page an operator opens to answer "is this instance healthy, and what is it costing me?" — running sandboxes, disk, spend per member, and the two subsystems that fail silently today.

**Architecture:** Almost all the data already exists. `usage_events` records per-model token counts per user; `lib/admin/storage-actions.ts` already measures workspaces and containers; the sandbox layer already lists containers. What is missing is a single read-only page that puts them together, plus health for the two things that break without saying so: the pg-boss job queue (a stuck queue looks exactly like "nothing happening") and pending migrations (which, as Phase 4 discovered the hard way, can be silently skipped). Everything is a read; the page duplicates no action that already exists elsewhere.

**Tech Stack:** Next.js 16, Drizzle + Postgres, pg-boss, dockerode, daisyUI, bun test.

## Global Constraints

- **Never use `any`** — `unknown` plus type guards. No `.js` extensions in imports.
- Files kebab-case; types PascalCase; functions camelCase. Double quotes, 2-space indent (`pnpm fix`).
- **Zod** for validation; derive types with `z.infer`.
- **All UI work goes through the daisyUI Blueprint MCP** — setup expert with a unique lowercase `workflowId` and absolute `projectRoot`, the mandatory rules enforcer, component syntax, then the quality inspector with `auditIntent: "fix_changes"` and paths **relative to projectRoot**.
- **`pnpm run ci` runs ONCE**, at the end of the phase.
- **Read-only.** This page reports; it does not act. Any control that changes state belongs on the page that already owns it.
- **Admin-only**, via the combined check Phase 2 established (`isUserAdmin(id) || isOrganizationAdmin(id)`) — not a bare `users.is_admin`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/health/queue-health.ts` (create) | pg-boss queue depth, failures, oldest pending job |
| `apps/web/lib/health/queue-health.test.ts` (create) | Healthy, backed-up, and failing classifications |
| `apps/web/lib/health/migration-health.ts` (create) | Applied vs journal — are any pending or skipped? |
| `apps/web/lib/health/migration-health.test.ts` (create) | In-sync, pending, and the out-of-order case |
| `apps/web/lib/health/spend.ts` (create) | Token and cost totals per member over a window |
| `apps/web/lib/health/spend.test.ts` (create) | Aggregation, empty instance, unknown model |
| `apps/web/lib/admin/health-actions.ts` (create) | One admin-guarded action returning the whole report |
| `apps/web/app/settings/health/page.tsx` (create) | The page |
| `apps/web/app/settings/health/*-card.tsx` (create) | One card per section |
| `apps/web/app/settings/layout.tsx` (modify) | Nav entry, admin-only |
| `docs/self-hosting.md` (modify) | What the page shows and how to read it |

---

### Task 1: Queue health

**Files:** create `apps/web/lib/health/queue-health.ts` and its test.

**Interfaces:**
- Produces: `readQueueHealth(): Promise<QueueHealth>` where
  `QueueHealth = { state: "idle" | "working" | "backed-up" | "failing"; pending: number; failedLastHour: number; oldestPendingAgeSeconds: number | null }`.

**Why this exists:** pg-boss delivers magic links and invitation emails. When it stalls, sign-in silently stops working and nothing anywhere says so — the symptom is "I never got the email", which looks like an SMTP problem and is not. This is the single highest-value thing on the page.

- [ ] **Step 1: Write the failing test**

Classification is the whole logic, so test it directly against counts rather than a live queue:

```ts
import { describe, expect, test } from "bun:test";
import { classifyQueue } from "./queue-health";

describe("classifyQueue", () => {
  test("nothing queued is idle", () => {
    expect(classifyQueue({ pending: 0, failedLastHour: 0, oldestPendingAgeSeconds: null }).state)
      .toBe("idle");
  });

  test("a few fresh jobs is working, not a problem", () => {
    expect(classifyQueue({ pending: 3, failedLastHour: 0, oldestPendingAgeSeconds: 5 }).state)
      .toBe("working");
  });

  test("a job that has waited far too long is backed up", () => {
    expect(classifyQueue({ pending: 1, failedLastHour: 0, oldestPendingAgeSeconds: 900 }).state)
      .toBe("backed-up");
  });

  test("recent failures are reported as failing even when the queue is short", () => {
    expect(classifyQueue({ pending: 0, failedLastHour: 4, oldestPendingAgeSeconds: null }).state)
      .toBe("failing");
  });

  test("failing outranks backed-up", () => {
    expect(classifyQueue({ pending: 20, failedLastHour: 4, oldestPendingAgeSeconds: 900 }).state)
      .toBe("failing");
  });
});
```

- [ ] **Step 2: Fail, then implement**

`classifyQueue` is a pure function over the three counts — export it separately from the query so the thresholds are testable without a database. Pick a "waited too long" threshold and **say why in a comment**: a magic link expires in 10 minutes (`MAGIC_LINK_EXPIRY_SECONDS` in `lib/auth/config.ts`), so a sign-in email still queued after a couple of minutes is already close to useless. That reasoning is the justification for the number; do not invent a round one.

`readQueueHealth` queries pg-boss's own tables in the `pgboss` schema (`job` and its archive). Read `lib/jobs/` first for how the instance is configured. If a count is unavailable, return the health object with that field zeroed rather than throwing — **a health page that 500s because one of its metrics is unavailable is worse than one that shows a gap.**

- [ ] **Step 3: Pass, commit**

```bash
bun test apps/web/lib/health/queue-health.test.ts
git add apps/web/lib/health/queue-health.ts apps/web/lib/health/queue-health.test.ts
git commit -m "feat: report whether the job queue is actually moving"
```

---

### Task 2: Migration health

**Files:** create `apps/web/lib/health/migration-health.ts` and its test.

**Interfaces:**
- Produces: `readMigrationHealth(): Promise<MigrationHealth>` where
  `MigrationHealth = { state: "in-sync" | "pending" | "out-of-order"; applied: number; total: number; pendingTags: string[] }`.

**Why this exists:** Phase 4 found migrations being **silently skipped** because a hand-written journal entry carried a future timestamp — the migrator reported success and applied nothing, and the failure surfaced as unrelated runtime errors. `lib/db/migration-clamp.ts` now prevents the specific cause. This surfaces the *condition*, so the next variant is visible instead of mysterious.

- [ ] **Step 1: Write the failing test**

Test the comparison as a pure function over a journal and a set of applied timestamps:

```ts
import { describe, expect, test } from "bun:test";
import { compareMigrations } from "./migration-health";

const journal = [
  { tag: "0000_a", when: 100 },
  { tag: "0001_b", when: 200 },
  { tag: "0002_c", when: 300 },
];

describe("compareMigrations", () => {
  test("everything applied is in sync", () => {
    const result = compareMigrations(journal, [100, 200, 300]);
    expect(result.state).toBe("in-sync");
    expect(result.pendingTags).toEqual([]);
  });

  test("a missing tail is pending", () => {
    const result = compareMigrations(journal, [100, 200]);
    expect(result.state).toBe("pending");
    expect(result.pendingTags).toEqual(["0002_c"]);
  });

  test("an applied timestamp beyond the journal is out of order", () => {
    // This is the shape that silently skipped migrations: something recorded
    // as applied is newer than anything the journal knows about, so the
    // migrator will never consider the entries in between.
    const result = compareMigrations(journal, [100, 200, 999]);
    expect(result.state).toBe("out-of-order");
  });

  test("an empty database is pending, not in sync", () => {
    expect(compareMigrations(journal, []).state).toBe("pending");
  });
});
```

- [ ] **Step 2: Implement, pass, commit**

`readMigrationHealth` reads `_journal.json` and `drizzle.__drizzle_migrations`. **Tolerate the table not existing** — that is a fresh database, which is `pending`, not an error.

```bash
git commit -m "feat: surface migrations that were never applied"
```

---

### Task 3: Spend per member

**Files:** create `apps/web/lib/health/spend.ts` and its test.

**Interfaces:**
- Produces: `readSpend(windowDays: number): Promise<SpendReport>` where
  `SpendReport = { windowDays: number; totalCostUsd: number; totalTokens: number; perMember: Array<{ userId: string; username: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: number }> }`.

- [ ] **Step 1: Check what already exists before writing anything**

`apps/web/app/settings/usage/usage-insights-section.tsx` already renders usage, and `usage_events` already stores per-model token counts. **Read both first.** If a cost calculation already exists, reuse it rather than writing a second one that will drift — two places computing money differently is worse than either. Say in your report what you found and what you reused.

- [ ] **Step 2: Test the aggregation**

Cover: an instance with no events returns zeros and an empty list; events from several users aggregate per user; events outside the window are excluded; an event whose model has no known price contributes tokens but zero cost **and is reported as unpriced** rather than silently counted as free.

- [ ] **Step 3: Implement, pass, commit**

---

### Task 4: One report

**Files:** create `apps/web/lib/admin/health-actions.ts`.

**Interfaces:**
- Produces: `getInstanceHealth(): Promise<InstanceHealth>` — one admin-guarded action returning queue, migrations, spend, storage and sandboxes together.

- [ ] **Step 1: Write it**

`"use server"`, `requireAdmin()` first. Gather the pieces with `Promise.allSettled`, **not** `Promise.all`: one failing metric must not blank the whole page. A rejected part becomes an explicit "unavailable" in the response, and the UI says so.

Reuse `lib/admin/storage-actions.ts` for disk and containers rather than re-measuring — it already exists and is already used by the admin page.

- [ ] **Step 2: Typecheck, commit**

---

### Task 5: The page

**Files:** create `apps/web/app/settings/health/page.tsx` and its cards; modify `apps/web/app/settings/layout.tsx`.

- [ ] **Step 1: Build it (daisyUI MCP, `workflowId: "paco-instance-health"`)**

One card per section: **Queue**, **Migrations**, **Spend**, **Storage & containers**. Requirements:

- Each card states what is *wrong* first, if anything, and otherwise reads quietly. A page that shouts at healthy instances gets ignored on the day it matters.
- The queue card explains what a stall means in the operator's terms — *sign-in and invitation emails are not being delivered* — not "N jobs pending".
- The migrations card, when out of sync, names the pending tags and says what to run.
- Spend shows per-member totals with a window selector, and marks any model whose price is unknown rather than showing it as free.
- An unavailable metric renders as unavailable, with its reason. It does not render as zero — **zero is a claim, and the wrong one.**

Add the nav entry in `settings/layout.tsx`, visible only to admins, matching how the existing Users and Admin entries are gated.

- [ ] **Step 2: Audit and verify**

`daisyui_quality_inspector` with `auditIntent: "fix_changes"`. Then look at it in the browser against the running dev server on http://localhost:3066 — do not start another. Say which states you saw and which you could not.

- [ ] **Step 3: Commit**

---

### Task 6: Documentation and close-out

- [ ] **Step 1: Document it**

`docs/self-hosting.md`: what the page shows, and specifically how to read the queue and migration cards — those are the two that tell an operator something they cannot easily find out otherwise.

- [ ] **Step 2: Confirm it is read-only**

Run: `grep -rn "delete\|remove\|revoke\|destroy" apps/web/app/settings/health apps/web/lib/health apps/web/lib/admin/health-actions.ts`
Read every hit. Anything that mutates state belongs on the page that owns that action, not here.

- [ ] **Step 3: Run the full checks, once**

Run: `pnpm run ci`

- [ ] **Step 4: Commit**

---

## Self-Review

**Spec coverage.** The spec's Phase 5 asks for running sandboxes with their chat and uptime, workspace disk against the volume, token and cost totals per member, Postgres reachability and pending-migration state, and the last errors from the job queue. Tasks 1–5 cover all of it. Postgres reachability is implicit: every part of the report is a query, so a database that cannot be reached renders every card unavailable — which is the honest presentation and needs no separate check.

**Deliberately not built.** No alerting, no history, no charts over time. The spec asks for a page that answers a question now; retention and alerting are a different product decision and would need a storage design of their own.

**Type consistency.** `QueueHealth`, `MigrationHealth` and `SpendReport` are defined in Tasks 1–3 and composed unchanged into `InstanceHealth` in Task 4; Task 5 renders that type and nothing else. The `"unavailable"` case is part of `InstanceHealth`, not a UI-only concept, so the server decides what is unknown and the page cannot accidentally present a gap as a zero.

**Known risk.** Task 1 queries pg-boss's internal tables, which are not a public API and can change across major versions. That is a real coupling and the reason the query is isolated in one module with the classification split out as a pure function — if the schema moves, one file changes and the tested logic does not.
