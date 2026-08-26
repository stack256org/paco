# Section 1: Event-Log Spine + AgentBackend Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only `session_events` log as the source of truth for chat history, and put the agent behind a neutral `AgentBackend` interface with turn steering — so Claude Code becomes one implementation and OpenFX can become the second.

**Architecture:** A new `@paco/agent-backend` package owns the event vocabulary, the backend interface, a fake backend, and a conformance suite. `@paco/claude-code` gains a `ClaudeCodeBackend` implementing the interface by wrapping `streamClaudeAgent`. The web app appends events from the workflow layer (where UI chunks already flow), projects assistant messages from events for a replay-equivalence test, and implements steer/queue turn policies over durable `steer/buffered` events.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Bun tests, `ai` (AI SDK v6 UI message types), Zod v4 (catalog).

**Spec:** `docs/superpowers/specs/2026-08-25-paco-platform-design.md` (Section 1)

## Global Constraints

- pnpm exclusively; Bun for tests (`bun test path/to/file.test.ts`). Never npm/yarn.
- Do NOT run `pnpm run ci` per task — it runs once at the very end of the branch. Per task run only the narrow tests you touched plus `turbo typecheck --filter=<pkg>` when types changed.
- **Never use `any`** — use `unknown` and narrow. No `.js` extension style changes: inside `packages/*`, relative imports use explicit `.ts` extensions (existing pattern); inside `apps/web`, use the `@/` alias with no extension.
- Files kebab-case; types PascalCase; functions camelCase. Zod schemas for validation with `z.infer` derived types.
- After ANY change to `apps/web/lib/db/schema.ts`: run `pnpm --dir apps/web db:generate` and commit the generated `.sql` migration alongside. Never `db:push`.
- Formatting/linting is Ultracite (oxlint + oxfmt): run `pnpm fix` before each commit.
- Quote paths containing `[` `]` in git commands (zsh globbing).
- The spec's invariant is binding: **anything that reaches a model request must be reconstructable from the log.**
- Event append failures must never fail a turn: every append site catches and `console.error`s (the log is additive in Section 1; equivalence is asserted in tests, not at runtime request paths).

---

### Task 1: `@paco/agent-backend` package with the SessionEvent vocabulary

**Files:**
- Create: `packages/agent-backend/package.json`
- Create: `packages/agent-backend/tsconfig.json`
- Create: `packages/agent-backend/events.ts`
- Create: `packages/agent-backend/index.ts`
- Test: `packages/agent-backend/events.test.ts`

**Interfaces:**
- Consumes: nothing (leaf package). `ai` for `UIMessageChunk`.
- Produces: `SessionEvent` union, `SessionEventType`, `sessionEventSchema` (Zod), `isSessionEvent`, `TurnUsage`, `zeroUsage()` — used by every later task.

- [ ] **Step 1: Scaffold the package**

`packages/agent-backend/package.json`:

```json
{
  "name": "@paco/agent-backend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./index.ts",
  "exports": {
    ".": "./index.ts",
    "./events.js": "./events.ts",
    "./interface.js": "./interface.ts",
    "./fake-backend.js": "./fake-backend.ts",
    "./conformance.js": "./conformance.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ai": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@paco/tsconfig": "workspace:*",
    "@types/bun": "1.3.14",
    "@types/node": "^22"
  },
  "peerDependencies": {
    "typescript": "^7"
  }
}
```

`packages/agent-backend/tsconfig.json`:

```json
{
  "extends": "@paco/tsconfig/bun.json",
  "include": ["./**/*"],
  "exclude": ["node_modules"],
  "compilerOptions": {
    "strictNullChecks": true
  }
}
```

Run `pnpm install` at the repo root so the workspace links the new package.

Note: `interface.ts`, `fake-backend.ts`, and `conformance.ts` are declared in `exports` now but created in Tasks 3–4; the missing files are fine until then because nothing imports them yet.

- [ ] **Step 2: Write the failing test**

`packages/agent-backend/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  isSessionEvent,
  sessionEventSchema,
  zeroUsage,
} from "./events.ts";

describe("sessionEventSchema", () => {
  test("accepts a turn/start event", () => {
    const event = {
      type: "turn/start",
      turnId: "turn_1",
      messageId: "msg_1",
      prompt: "build a widget",
      policy: "steer",
    };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  test("accepts an assistant/chunk event with an arbitrary chunk", () => {
    const event = {
      type: "assistant/chunk",
      turnId: "turn_1",
      chunk: { type: "text-delta", id: "t1", delta: "hi" },
    };
    expect(sessionEventSchema.parse(event).type).toBe("assistant/chunk");
  });

  test("accepts turn/end with usage and steered payloads", () => {
    const event = {
      type: "turn/end",
      turnId: "turn_1",
      finishReason: "stop",
      isError: false,
      steered: { text: "actually, use pnpm" },
    };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  test("rejects an unknown type", () => {
    expect(() =>
      sessionEventSchema.parse({ type: "bogus/none" }),
    ).toThrow();
  });

  test("isSessionEvent narrows", () => {
    expect(isSessionEvent({ type: "steer/buffered", messageId: "m", text: "x" })).toBe(true);
    expect(isSessionEvent({ type: "nope" })).toBe(false);
    expect(isSessionEvent(null)).toBe(false);
  });
});

describe("zeroUsage", () => {
  test("is all zeros with empty models", () => {
    expect(zeroUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agent-backend/events.test.ts`
Expected: FAIL — cannot resolve `./events.ts`.

- [ ] **Step 4: Implement `events.ts`**

```ts
import type { UIMessageChunk } from "ai";
import { z } from "zod";

/**
 * Token/cost accounting for one backend turn.
 *
 * Backend-neutral twin of @paco/claude-code's ClaudeRunUsage — same shape, so
 * the Claude implementation can pass its usage through unchanged.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd?: number;
  models: Record<string, { inputTokens: number; outputTokens: number }>;
}

export function zeroUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    models: {},
  };
}

const turnUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  totalCostUsd: z.number().optional(),
  models: z.record(
    z.string(),
    z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  ),
});

export const finishReasonSchema = z.enum([
  "stop",
  "length",
  "error",
  "tool-calls",
]);
export type TurnFinishReason = z.infer<typeof finishReasonSchema>;

export const turnPolicySchema = z.enum(["steer", "queue"]);
export type TurnPolicy = z.infer<typeof turnPolicySchema>;

/**
 * The session event vocabulary.
 *
 * Spec invariant: anything that reaches a model request must be
 * reconstructable from the log. UI-chunk-native backends (Claude Code) log
 * tool activity inside `assistant/chunk`; `tool/call` and `tool/result`
 * exist for backends without a chunk protocol (OpenFX later). Both routes
 * are legal; the projection understands the chunk route.
 */
export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn/start"),
    turnId: z.string(),
    messageId: z.string(),
    prompt: z.string(),
    policy: turnPolicySchema,
  }),
  z.object({
    type: z.literal("user/message"),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant/chunk"),
    turnId: z.string(),
    // UIMessageChunk is a wide union owned by the AI SDK; the log stores it
    // verbatim and the projection re-streams it, so passthrough is correct.
    chunk: z.unknown(),
  }),
  z.object({
    type: z.literal("assistant/message"),
    turnId: z.string(),
    messageId: z.string(),
    message: z.unknown(),
  }),
  z.object({
    type: z.literal("tool/call"),
    turnId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool/result"),
    turnId: z.string(),
    toolCallId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("approval/requested"),
    turnId: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("approval/decided"),
    turnId: z.string(),
    requestId: z.string(),
    decision: z.enum(["approved", "denied"]),
  }),
  z.object({
    type: z.literal("steer/buffered"),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("steer/consumed"),
    messageId: z.string(),
    mode: turnPolicySchema,
  }),
  z.object({
    type: z.literal("usage/reported"),
    turnId: z.string(),
    usage: turnUsageSchema,
    costUsd: z.number().optional(),
  }),
  z.object({
    type: z.literal("turn/end"),
    turnId: z.string(),
    finishReason: finishReasonSchema,
    isError: z.boolean(),
    steered: z.object({ text: z.string() }).optional(),
  }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

export function isSessionEvent(value: unknown): value is SessionEvent {
  return sessionEventSchema.safeParse(value).success;
}

/** Narrow helper: the chunk payload of an assistant/chunk event. */
export function chunkOf(event: SessionEvent & { type: "assistant/chunk" }): UIMessageChunk {
  return event.chunk as UIMessageChunk;
}
```

`packages/agent-backend/index.ts` (for now — Tasks 3–4 extend it):

```ts
export * from "./events.ts";
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `bun test packages/agent-backend/events.test.ts` → PASS (6 tests).
Run: `turbo typecheck --filter=@paco/agent-backend` → clean.
Run: `pnpm fix`

```bash
git add packages/agent-backend pnpm-lock.yaml
git commit -m "Add @paco/agent-backend with the session event vocabulary"
```

---

### Task 2: `session_events` table + append/list helpers

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (append after `chatReads`, around line 391)
- Create: `apps/web/lib/db/session-events.ts`
- Create: migration via `pnpm --dir apps/web db:generate`
- Test: `apps/web/lib/db/session-events.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`, `isSessionEvent` from `@paco/agent-backend` (Task 1).
- Produces: `appendSessionEvents(chatId: string, events: SessionEvent[]): Promise<void>` (batch insert, never throws — catches and logs); `listSessionEvents(chatId: string, opts?: { afterId?: number }): Promise<Array<{ id: number; event: SessionEvent }>>`; `listUnconsumedSteerEvents(chatId: string): Promise<Array<{ id: number; messageId: string; text: string }>>`.

- [ ] **Step 1: Add the table to `schema.ts`**

Add `bigserial` to the existing `drizzle-orm/pg-core` import in `apps/web/lib/db/schema.ts`, then append after the `chatReads` table:

```ts
/**
 * Append-only session event log — the source of truth for what happened in a
 * chat (spec: Section 1 of 2026-08-25-paco-platform-design.md).
 *
 * `chatMessages` is a projection of this log. Ordering is the bigserial `id`:
 * a single writer per chat is already enforced by the active-stream claim, so
 * global insert order is per-chat order.
 */
export const sessionEvents = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("session_events_chat_id_id_idx").on(table.chatId, table.id)],
);
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `pnpm --dir apps/web db:generate`
Expected: a new `.sql` file under `apps/web/lib/db/migrations/` creating `session_events` with the index and FK. Read it to confirm; commit it with the schema change at the end of the task.

- [ ] **Step 3: Write the failing test**

Look at `apps/web/lib/db/sessions.test.ts` first and mirror how it obtains a database handle. If (and only if) that file skips without a configured `POSTGRES_URL`/test database, follow the identical guard pattern so CI behavior matches the existing suite.

`apps/web/lib/db/session-events.test.ts` — the behavioral core (adapt setup/teardown to the sessions.test.ts pattern, creating a user/org/session/chat row as that file does so the FK holds):

```ts
import { describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  listSessionEvents,
  listUnconsumedSteerEvents,
} from "./session-events";

describe("session events", () => {
  test("append then list round-trips in order", async () => {
    const chatId = /* created chat id from setup */ "";
    await appendSessionEvents(chatId, [
      { type: "turn/start", turnId: "t1", messageId: "m1", prompt: "hi", policy: "steer" },
      { type: "assistant/chunk", turnId: "t1", chunk: { type: "text-delta", id: "a", delta: "h" } },
      { type: "turn/end", turnId: "t1", finishReason: "stop", isError: false },
    ]);
    const rows = await listSessionEvents(chatId);
    expect(rows.map((r) => r.event.type)).toEqual(["turn/start", "assistant/chunk", "turn/end"]);
    expect(rows[0]!.id).toBeLessThan(rows[2]!.id);
  });

  test("afterId filters", async () => {
    const chatId = /* second chat id */ "";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "first" },
    ]);
    const [first] = await listSessionEvents(chatId);
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s2", text: "second" },
    ]);
    const after = await listSessionEvents(chatId, { afterId: first!.id });
    expect(after).toHaveLength(1);
    expect(after[0]!.event.type).toBe("steer/buffered");
  });

  test("unconsumed steer events exclude consumed ones", async () => {
    const chatId = /* third chat id */ "";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "one" },
      { type: "steer/buffered", messageId: "s2", text: "two" },
      { type: "steer/consumed", messageId: "s1", mode: "steer" },
    ]);
    const pending = await listUnconsumedSteerEvents(chatId);
    expect(pending.map((p) => p.messageId)).toEqual(["s2"]);
  });

  test("append never throws on a bad chat id", async () => {
    await expect(
      appendSessionEvents("chat_that_does_not_exist", [
        { type: "steer/buffered", messageId: "x", text: "y" },
      ]),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test apps/web/lib/db/session-events.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `session-events.ts`**

```ts
import "server-only";

import { isSessionEvent, type SessionEvent } from "@paco/agent-backend";
import { asc, eq, gt, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sessionEvents } from "@/lib/db/schema";

/**
 * Append events to a chat's log.
 *
 * Never throws: the log is additive context in Section 1, and a failed append
 * must not fail the turn that produced it (Global Constraints).
 */
export async function appendSessionEvents(
  chatId: string,
  events: SessionEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  try {
    await db.insert(sessionEvents).values(
      events.map((event) => ({ chatId, type: event.type, payload: event })),
    );
  } catch (error) {
    console.error("session-events: append failed", { chatId, count: events.length, error });
  }
}

export async function listSessionEvents(
  chatId: string,
  opts?: { afterId?: number },
): Promise<Array<{ id: number; event: SessionEvent }>> {
  const where =
    opts?.afterId !== undefined
      ? and(eq(sessionEvents.chatId, chatId), gt(sessionEvents.id, opts.afterId))
      : eq(sessionEvents.chatId, chatId);

  const rows = await db
    .select({ id: sessionEvents.id, payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(where)
    .orderBy(asc(sessionEvents.id));

  const result: Array<{ id: number; event: SessionEvent }> = [];
  for (const row of rows) {
    if (isSessionEvent(row.payload)) {
      result.push({ id: row.id, event: row.payload });
    }
  }
  return result;
}

/** Buffered steer messages not yet consumed by a turn. */
export async function listUnconsumedSteerEvents(
  chatId: string,
): Promise<Array<{ id: number; messageId: string; text: string }>> {
  const rows = await listSessionEvents(chatId);
  const consumed = new Set<string>();
  for (const { event } of rows) {
    if (event.type === "steer/consumed") {
      consumed.add(event.messageId);
    }
  }
  const pending: Array<{ id: number; messageId: string; text: string }> = [];
  for (const { id, event } of rows) {
    if (event.type === "steer/buffered" && !consumed.has(event.messageId)) {
      pending.push({ id, messageId: event.messageId, text: event.text });
    }
  }
  return pending;
}
```

Add `"@paco/agent-backend": "workspace:*"` to `apps/web/package.json` dependencies and run `pnpm install`.

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `bun test apps/web/lib/db/session-events.test.ts` → PASS (or SKIP matching the sessions.test.ts guard, in which case run it once locally with the dev database per docs/contributing.md and paste the passing output in your report).
Run: `turbo typecheck --filter=web` → clean. `pnpm fix`.

```bash
git add apps/web/lib/db apps/web/package.json pnpm-lock.yaml
git commit -m "Add append-only session_events table with helpers"
```

---

### Task 3: `AgentBackend` interface + `FakeBackend`

**Files:**
- Create: `packages/agent-backend/interface.ts`
- Create: `packages/agent-backend/fake-backend.ts`
- Modify: `packages/agent-backend/index.ts`
- Test: `packages/agent-backend/fake-backend.test.ts`

**Interfaces:**
- Consumes: Task 1's `TurnUsage`, `TurnFinishReason`, `zeroUsage`.
- Produces (used by Tasks 4, 5, 6, and every future backend):

```ts
interface AgentBackend { capabilities(): BackendCapabilities; startTurn(ctx: TurnContext): TurnHandle; }
interface TurnHandle { chunks: AsyncIterable<UIMessageChunk>; result: Promise<TurnResult>; steer(text: string): Promise<void>; interrupt(): void; }
```

- [ ] **Step 1: Write `interface.ts`**

```ts
import type { UIMessageChunk } from "ai";
import type { TurnFinishReason, TurnUsage } from "./events.ts";

/**
 * What a backend supports, declared rather than assumed, so the UI and the
 * workflow adapt instead of breaking when a backend lacks a feature (spec 1b).
 */
export interface BackendCapabilities {
  /** Stable identifier, e.g. "claude-code", "openfx". */
  id: string;
  /** Can a later turn resume this backend's own conversation state? */
  resume: boolean;
  /** How steer() behaves: "restart" ends the turn carrying the steer text; "none" rejects. */
  steering: "restart" | "none";
  /** Does the backend accept MCP server configuration? */
  mcp: boolean;
  /** Does the backend accept a reasoning-effort setting? */
  effort: boolean;
  /** Does the backend run its own subagent roster? */
  subagents: boolean;
}

export interface TurnContext {
  /** Host working directory for the turn (a chat's worktree). */
  cwd: string;
  /** The user prompt for this turn. */
  prompt: string;
  /** Resume token from a prior turn's TurnResult, when capabilities().resume. */
  resumeToken?: string;
  /** Cooperative cancellation for the whole turn. */
  abortSignal?: AbortSignal;
  /**
   * Backend-specific options bag. Each implementation documents and narrows
   * its own shape; the neutral interface does not interpret it.
   */
  backendOptions?: unknown;
}

export interface TurnResult {
  finishReason: TurnFinishReason;
  isError: boolean;
  usage: TurnUsage;
  costUsd?: number;
  /** Token to pass as the next turn's resumeToken, when supported. */
  resumeToken?: string;
  /** Set when the turn ended because steer() was called; carries the steer text. */
  steered?: { text: string };
}

export class SteeringUnsupportedError extends Error {
  constructor(backendId: string) {
    super(`Backend "${backendId}" does not support steering`);
    this.name = "SteeringUnsupportedError";
  }
}

/**
 * One running turn.
 *
 * Contract (enforced by the conformance suite):
 * - `chunks` yields zero or more UI chunks, then ends; `result` settles only
 *   after `chunks` is fully consumed.
 * - `interrupt()` aborts the turn: `result` REJECTS with an error whose
 *   `name` is "AbortError".
 * - `steer(text)` with steering "restart": the turn winds down and `result`
 *   RESOLVES with `steered: { text }` and `isError: false`. With steering
 *   "none": `steer` rejects with SteeringUnsupportedError and the turn
 *   continues unaffected.
 */
export interface TurnHandle {
  chunks: AsyncIterable<UIMessageChunk>;
  result: Promise<TurnResult>;
  steer(text: string): Promise<void>;
  interrupt(): void;
}

export interface AgentBackend {
  capabilities(): BackendCapabilities;
  startTurn(ctx: TurnContext): TurnHandle;
}
```

- [ ] **Step 2: Write the failing test**

`packages/agent-backend/fake-backend.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { FakeBackend } from "./fake-backend.ts";

async function collect(chunks: AsyncIterable<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

describe("FakeBackend", () => {
  test("streams scripted chunks then resolves result", async () => {
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "hello" },
        { type: "text-end", id: "t1" },
      ],
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    const chunks = await collect(handle.chunks);
    expect(chunks).toHaveLength(3);
    const result = await handle.result;
    expect(result.finishReason).toBe("stop");
    expect(result.resumeToken).toBe("fake-session-1");
  });

  test("interrupt rejects result with AbortError", async () => {
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    handle.interrupt();
    expect(collect(handle.chunks)).resolves.toBeDefined();
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("steer resolves result with steered payload", async () => {
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    await handle.steer("change of plan");
    await collect(handle.chunks);
    const result = await handle.result;
    expect(result.steered).toEqual({ text: "change of plan" });
    expect(result.isError).toBe(false);
  });

  test("steering none rejects steer and turn continues", async () => {
    const backend = new FakeBackend({
      script: [
        { type: "text-start", id: "t1" },
        { type: "text-end", id: "t1" },
      ],
      steering: "none",
    });
    const handle = backend.startTurn({ cwd: "/tmp", prompt: "hi" });
    await expect(handle.steer("nope")).rejects.toMatchObject({
      name: "SteeringUnsupportedError",
    });
    await collect(handle.chunks);
    const result = await handle.result;
    expect(result.steered).toBeUndefined();
  });

  test("abort signal in context aborts the turn", async () => {
    const controller = new AbortController();
    const backend = new FakeBackend({
      script: [{ type: "text-start", id: "t1" }],
      holdOpen: true,
    });
    const handle = backend.startTurn({
      cwd: "/tmp",
      prompt: "hi",
      abortSignal: controller.signal,
    });
    controller.abort();
    await collect(handle.chunks);
    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/agent-backend/fake-backend.test.ts`
Expected: FAIL — `fake-backend.ts` missing.

- [ ] **Step 4: Implement `fake-backend.ts`**

```ts
import type { UIMessageChunk } from "ai";
import { zeroUsage } from "./events.ts";
import {
  type AgentBackend,
  type BackendCapabilities,
  SteeringUnsupportedError,
  type TurnContext,
  type TurnHandle,
  type TurnResult,
} from "./interface.ts";

export interface FakeBackendConfig {
  /** Chunks to emit, in order. */
  script: UIMessageChunk[];
  /** Keep the turn open after the script until steer/interrupt/abort. */
  holdOpen?: boolean;
  steering?: "restart" | "none";
  resumeToken?: string;
}

function abortError(): Error {
  const error = new Error("Turn was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Scripted in-memory backend for tests and the conformance suite. Emits its
 * script, then either finishes or (holdOpen) waits for steer/interrupt.
 */
export class FakeBackend implements AgentBackend {
  private readonly config: FakeBackendConfig;

  constructor(config: FakeBackendConfig) {
    this.config = config;
  }

  capabilities(): BackendCapabilities {
    return {
      id: "fake",
      resume: true,
      steering: this.config.steering ?? "restart",
      mcp: false,
      effort: false,
      subagents: false,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    const { script, holdOpen, resumeToken } = this.config;
    const steering = this.config.steering ?? "restart";
    const resultDeferred = Promise.withResolvers<TurnResult>();
    // Settled when something ends the held-open phase.
    const release = Promise.withResolvers<
      { kind: "steer"; text: string } | { kind: "abort" } | { kind: "end" }
    >();

    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        release.resolve({ kind: "abort" });
      } else {
        ctx.abortSignal.addEventListener(
          "abort",
          () => release.resolve({ kind: "abort" }),
          { once: true },
        );
      }
    }

    const token = resumeToken ?? "fake-session-1";

    async function* chunks(): AsyncGenerator<UIMessageChunk> {
      for (const chunk of script) {
        yield chunk;
      }
      const outcome = holdOpen
        ? await release.promise
        : await Promise.race([
            release.promise,
            Promise.resolve({ kind: "end" as const }),
          ]);

      if (outcome.kind === "abort") {
        resultDeferred.reject(abortError());
        return;
      }
      if (outcome.kind === "steer") {
        resultDeferred.resolve({
          finishReason: "stop",
          isError: false,
          usage: zeroUsage(),
          resumeToken: token,
          steered: { text: outcome.text },
        });
        return;
      }
      resultDeferred.resolve({
        finishReason: "stop",
        isError: false,
        usage: zeroUsage(),
        resumeToken: token,
      });
    }

    return {
      chunks: chunks(),
      result: resultDeferred.promise,
      steer: (text: string) => {
        if (steering === "none") {
          return Promise.reject(new SteeringUnsupportedError("fake"));
        }
        release.resolve({ kind: "steer", text });
        return Promise.resolve();
      },
      interrupt: () => {
        release.resolve({ kind: "abort" });
      },
    };
  }
}
```

Update `packages/agent-backend/index.ts`:

```ts
export * from "./events.ts";
export * from "./interface.ts";
export * from "./fake-backend.ts";
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `bun test packages/agent-backend/` → PASS (all files).
Run: `turbo typecheck --filter=@paco/agent-backend` → clean. `pnpm fix`.

```bash
git add packages/agent-backend
git commit -m "Add AgentBackend interface and FakeBackend"
```

---

### Task 4: Conformance suite

**Files:**
- Create: `packages/agent-backend/conformance.ts`
- Modify: `packages/agent-backend/index.ts`
- Test: `packages/agent-backend/conformance.test.ts`

**Interfaces:**
- Consumes: Task 3's interface + FakeBackend.
- Produces: `runBackendConformance(name: string, factory: ConformanceFactory): void` — the definition of done for every backend (spec Section 7 exit criterion). `ConformanceFactory = () => { backend: AgentBackend; turnContext: TurnContext }` where `turnContext` must start a turn that emits at least one chunk and stays open long enough to steer/interrupt (each conformance case calls the factory fresh).

- [ ] **Step 1: Write `conformance.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { AgentBackend, TurnContext } from "./interface.ts";

export interface ConformanceSetup {
  backend: AgentBackend;
  /** Must produce a turn that emits ≥1 chunk and, until steered/interrupted, stays open. */
  turnContext: TurnContext;
}

export type ConformanceFactory = () => ConformanceSetup;

async function collect(chunks: AsyncIterable<UIMessageChunk>) {
  const out: UIMessageChunk[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

const FINISH_REASONS = new Set(["stop", "length", "error", "tool-calls"]);

/**
 * The backend contract, as executable tests. Passing this suite is the
 * definition of done for an AgentBackend implementation.
 */
export function runBackendConformance(
  name: string,
  factory: ConformanceFactory,
): void {
  describe(`AgentBackend conformance: ${name}`, () => {
    test("declares coherent capabilities", () => {
      const { backend } = factory();
      const caps = backend.capabilities();
      expect(caps.id.length).toBeGreaterThan(0);
      expect(["restart", "none"]).toContain(caps.steering);
    });

    test("a steered or completed turn emits chunks then settles result", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      if (backend.capabilities().steering === "restart") {
        await handle.steer("wrap up");
      }
      const chunks = await collect(handle.chunks);
      expect(chunks.length).toBeGreaterThan(0);
      const result = await handle.result;
      expect(FINISH_REASONS.has(result.finishReason)).toBe(true);
      expect(typeof result.isError).toBe("boolean");
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    test("interrupt rejects result with AbortError", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      handle.interrupt();
      await collect(handle.chunks).catch(() => []);
      await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    });

    test("steer follows the declared capability", async () => {
      const { backend, turnContext } = factory();
      const caps = backend.capabilities();
      const handle = backend.startTurn(turnContext);
      if (caps.steering === "restart") {
        await handle.steer("different direction");
        await collect(handle.chunks);
        const result = await handle.result;
        expect(result.steered).toEqual({ text: "different direction" });
        expect(result.isError).toBe(false);
      } else {
        await expect(handle.steer("x")).rejects.toMatchObject({
          name: "SteeringUnsupportedError",
        });
        handle.interrupt();
        await collect(handle.chunks).catch(() => []);
        await handle.result.catch(() => undefined);
      }
    });

    test("resume declared ⇒ resumeToken returned", async () => {
      const { backend, turnContext } = factory();
      const handle = backend.startTurn(turnContext);
      if (backend.capabilities().steering === "restart") {
        await handle.steer("finish");
      }
      await collect(handle.chunks);
      const result = await handle.result;
      if (backend.capabilities().resume) {
        expect(typeof result.resumeToken).toBe("string");
        expect((result.resumeToken ?? "").length).toBeGreaterThan(0);
      }
    });

    test("pre-aborted context signal rejects with AbortError", async () => {
      const { backend, turnContext } = factory();
      const controller = new AbortController();
      controller.abort();
      const handle = backend.startTurn({
        ...turnContext,
        abortSignal: controller.signal,
      });
      await collect(handle.chunks).catch(() => []);
      await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    });
  });
}
```

Do NOT export conformance from `index.ts` (it imports `bun:test`, which must not load in the Next.js app). Leave it reachable only via the `./conformance.js` export path already declared in `package.json`.

- [ ] **Step 2: Run the suite against FakeBackend**

`packages/agent-backend/conformance.test.ts`:

```ts
import { runBackendConformance } from "./conformance.ts";
import { FakeBackend } from "./fake-backend.ts";

runBackendConformance("FakeBackend (restart steering)", () => ({
  backend: new FakeBackend({
    script: [{ type: "text-start", id: "t1" }],
    holdOpen: true,
  }),
  turnContext: { cwd: "/tmp", prompt: "conformance" },
}));

runBackendConformance("FakeBackend (no steering)", () => ({
  backend: new FakeBackend({
    script: [{ type: "text-start", id: "t1" }],
    holdOpen: true,
    steering: "none",
  }),
  turnContext: { cwd: "/tmp", prompt: "conformance" },
}));
```

- [ ] **Step 3: Run tests**

Run: `bun test packages/agent-backend/` → all pass. If the "no steering" variant hangs in the completed-turn cases, re-check the conformance code paths above — they interrupt and swallow for `steering: "none"` where a turn cannot be told to wrap up.

- [ ] **Step 4: Typecheck and commit**

Run: `turbo typecheck --filter=@paco/agent-backend` → clean. `pnpm fix`.

```bash
git add packages/agent-backend
git commit -m "Add AgentBackend conformance suite"
```

---

### Task 5: `ClaudeCodeBackend`

**Files:**
- Create: `packages/claude-code/backend.ts`
- Modify: `packages/claude-code/index.ts` (add `export * from "./backend.ts";`)
- Modify: `packages/claude-code/package.json` (add `"./backend.js": "./backend.ts"` to exports; add `"@paco/agent-backend": "workspace:*"` to dependencies)
- Test: `packages/claude-code/backend.test.ts`

**Interfaces:**
- Consumes: `streamClaudeAgent`, `toRunUsage`, `toFinishReason` from `./agent.ts`; `ClaudeCodeOptions` from `./options.ts`; Task 3's interface types.
- Produces: `class ClaudeCodeBackend implements AgentBackend` with `startTurn(ctx)` where `ctx.backendOptions` is `Omit<ClaudeCodeOptions, "cwd" | "resume">` — cwd and resume come from the neutral `TurnContext` fields.

- [ ] **Step 1: Read the existing test fixtures**

Read `packages/claude-code/agent.test.ts` and `packages/claude-code/resume.test.ts` before writing anything. They fake the CLI with a stub executable; reuse that exact pattern (helper names, tmp-dir layout) for the backend tests rather than inventing a new one. If they expose a shared helper, import it; if the fixture is inline, copy its shape.

- [ ] **Step 2: Write the failing test**

`packages/claude-code/backend.test.ts` — using the fixture pattern from Step 1, cover:

```ts
// 1. A scripted CLI run: startTurn streams the mapped UI chunks and result
//    resolves with finishReason "stop", isError false, resumeToken === the
//    scripted session id, and usage mapped via toRunUsage.
// 2. interrupt(): result rejects with name "AbortError" (the CLI stub should
//    sleep between init and result so the interrupt lands mid-run).
// 3. steer("new text"): result RESOLVES with steered {text: "new text"},
//    isError false, finishReason "stop" — even though the underlying process
//    was SIGTERMed (the backend converts its own steer-abort into success).
// 4. capabilities(): { id: "claude-code", resume: true, steering: "restart",
//    mcp: false, effort: true, subagents: true }.
//    (mcp stays false until Section 2 opens --mcp-config.)
// 5. Conformance: import { runBackendConformance } from
//    "@paco/agent-backend/conformance.js" and run it with a factory whose
//    backendOptions point executable at a stub that emits init + one
//    stream chunk, then sleeps 10s before the result line — long enough for
//    steer/interrupt to land, short enough not to stall a passing run
//    (steer/interrupt land within milliseconds; 10s is only the failure
//    ceiling).
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/claude-code/backend.test.ts`
Expected: FAIL — `backend.ts` missing.

- [ ] **Step 4: Implement `backend.ts`**

```ts
import {
  type AgentBackend,
  type BackendCapabilities,
  type TurnContext,
  type TurnHandle,
  type TurnResult,
  zeroUsage,
} from "@paco/agent-backend";
import type { UIMessageChunk } from "ai";
import { streamClaudeAgent } from "./agent.ts";
import { toFinishReason, toRunUsage } from "./agent.ts";
import type { ClaudeCodeOptions } from "./options.ts";

/** Per-turn options for the Claude Code backend, minus the neutral fields. */
export type ClaudeBackendOptions = Omit<ClaudeCodeOptions, "cwd" | "resume">;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * AgentBackend implementation over the Claude Code CLI.
 *
 * Steering is "restart": steer() SIGTERMs the run and reports the turn as
 * cleanly steered; the caller starts the next turn with the steer text and
 * the returned resumeToken, which is how the CLI's own history carries over.
 */
export class ClaudeCodeBackend implements AgentBackend {
  capabilities(): BackendCapabilities {
    return {
      id: "claude-code",
      resume: true,
      steering: "restart",
      mcp: false,
      effort: true,
      subagents: true,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    const backendOptions = (ctx.backendOptions ?? {}) as ClaudeBackendOptions;
    const controller = new AbortController();

    const onOuterAbort = () => controller.abort();
    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        controller.abort();
      } else {
        ctx.abortSignal.addEventListener("abort", onOuterAbort, { once: true });
      }
    }

    let steerText: string | undefined;
    let latestSessionId: string | undefined;

    const options: ClaudeCodeOptions = {
      ...backendOptions,
      cwd: ctx.cwd,
      ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
    };

    const run = streamClaudeAgent(ctx.prompt, options, controller.signal);
    run.sessionId.then((id) => {
      latestSessionId = id;
    }).catch(() => undefined);

    const result: Promise<TurnResult> = run.result.then(
      (terminal) => ({
        finishReason: toFinishReason(terminal),
        isError: terminal.is_error,
        usage: toRunUsage(terminal),
        costUsd: terminal.total_cost_usd,
        resumeToken: terminal.session_id,
      }),
      (error): TurnResult => {
        // A steer aborts the process on purpose; report it as a clean,
        // steered stop rather than an error.
        if (steerText !== undefined && isAbortError(error)) {
          return {
            finishReason: "stop",
            isError: false,
            usage: zeroUsage(),
            ...(latestSessionId ? { resumeToken: latestSessionId } : {}),
            steered: { text: steerText },
          };
        }
        throw error;
      },
    );
    // The workflow may consume chunks and result independently; an interrupt
    // rejection must not become an unhandled rejection before it is awaited.
    result.catch(() => undefined);

    async function* chunks(): AsyncGenerator<UIMessageChunk> {
      try {
        for await (const chunk of run.chunks) {
          yield chunk;
        }
      } catch (error) {
        // Aborts (steer or interrupt) end the stream; result carries the
        // outcome. Anything else propagates.
        if (!isAbortError(error)) {
          throw error;
        }
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onOuterAbort);
      }
    }

    return {
      chunks: chunks(),
      result,
      steer: (text: string) => {
        steerText = text;
        controller.abort();
        return Promise.resolve();
      },
      interrupt: () => {
        controller.abort();
      },
    };
  }
}
```

Note for the implementer: `streamClaudeAgent`'s stream throws `ClaudeCodeError` with `name === "AbortError"` on SIGTERM (see `run.ts`). Verify in your tests which of `run.chunks` iteration and `run.result` observes the abort, and adjust the catch placement if the real behavior differs from the sketch — the CONTRACT (result rejects AbortError on interrupt; resolves steered on steer) is what must hold, the sketch is how.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `bun test packages/claude-code/backend.test.ts` → PASS, conformance included.
Run: `turbo typecheck --filter=@paco/claude-code` → clean. `pnpm fix`.

```bash
git add packages/claude-code pnpm-lock.yaml
git commit -m "Add ClaudeCodeBackend implementing AgentBackend"
```

---

### Task 6: Route `runAgentTurn` through the backend

**Files:**
- Modify: `apps/web/lib/agent/run-step.ts`
- Modify: `apps/web/lib/agent/run-step.test.ts` (extend)

**Interfaces:**
- Consumes: `ClaudeCodeBackend`, `ClaudeBackendOptions` (Task 5); `AgentBackend`, `TurnHandle` (Task 3).
- Produces: `runAgentTurn` gains an optional `backend?: AgentBackend` param (defaults to `new ClaudeCodeBackend()`); its returned `AgentStepResult` unchanged except a new optional `steered?: { text: string }` passthrough. Behavior with no `backend` argument is IDENTICAL to today.

- [ ] **Step 1: Read `run-step.test.ts`** to learn how the existing tests fake the turn (they exercise `runAgentTurn` somehow — mirror it).

- [ ] **Step 2: Write the failing test** — extend `run-step.test.ts`:

```ts
// New test: "runAgentTurn drives a provided AgentBackend"
// - Construct FakeBackend (from @paco/agent-backend) with a script of
//   text-start/text-delta/text-end chunks.
// - Call runAgentTurn({ ..., backend }) with minimal options (reuse the
//   file's existing fixture helpers for AgentCallOptions).
// - Assert: every scripted chunk reached onChunk in order; the returned
//   responseMessage's text part contains the scripted delta text; usage is
//   the zeroUsage shape; claudeSessionId === "fake-session-1".
```

- [ ] **Step 3: Run to verify it fails** (no `backend` param exists).

- [ ] **Step 4: Refactor `run-step.ts`**

In `runAgentTurn`:
1. Add `backend?: AgentBackend` to the params interface.
2. Replace the direct `streamClaudeAgent(params.prompt, {...}, params.abortSignal)` call: build the SAME options object minus `cwd` and `resume` into a `const backendOptions: ClaudeBackendOptions = {...}` (everything currently passed: settings/env/model/effort/agents/appendSystemPrompt/permissionMode/sessionId/maxTurns/includePartialMessages), then:

```ts
const backend = params.backend ?? new ClaudeCodeBackend();
const handle = backend.startTurn({
  cwd: resolveHostCwd(options),
  prompt: params.prompt,
  ...(params.claudeSessionId ? { resumeToken: params.claudeSessionId } : {}),
  ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
  backendOptions,
});
```

3. The `ReadableStream` wrapper iterates `handle.chunks` instead of `run.chunks`; `const result = await handle.result;` replaces `await run.result`.
4. Map the neutral result back: `usage: result.usage`, `finishReason: result.finishReason`, `claudeSessionId: result.resumeToken ?? ""`, `costUsd: result.costUsd`, `isError: result.isError`, plus `...(result.steered ? { steered: result.steered } : {})` on the returned `AgentStepResult` (add the optional field to the interface).
5. The `sessionId: crypto.randomUUID()` fallback for a fresh chat moves into `backendOptions` (it is a Claude-specific option; keep the existing conditional exactly, just relocated).
6. Delete the now-unused `streamClaudeAgent`/`toRunUsage`/`toFinishReason` imports.

The failed-resume retry stays inside `streamClaudeAgent` — the backend inherits it for free; do not reimplement it.

- [ ] **Step 5: Run tests**

Run: `bun test apps/web/lib/agent/run-step.test.ts` → new AND existing tests pass (existing tests prove the default path unchanged).
Run: `turbo typecheck --filter=web` → clean.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add apps/web/lib/agent
git commit -m "Drive agent turns through the AgentBackend interface"
```

---

### Task 7: Emit session events from the workflow

**Files:**
- Modify: `apps/web/app/workflows/chat.ts` (the `"use step"` function that calls `runAgentTurn`, around lines 947–1010)
- Create: `apps/web/lib/agent/event-recorder.ts`
- Test: `apps/web/lib/agent/event-recorder.test.ts`

**Interfaces:**
- Consumes: `appendSessionEvents` (Task 2), `SessionEvent`, `TurnUsage` (Task 1).
- Produces: `class TurnEventRecorder` used by the workflow: `constructor(chatId: string, turnId: string)`, `.start(params: { messageId: string; prompt: string; policy: "steer" | "queue" })`, `.chunk(chunk: unknown)` (buffers, flushes every 50), `.finish(params: { finishReason; isError; usage?; costUsd?; steered? })` (flushes remaining chunks, then usage/reported if usage given, then turn/end), `.assertPromptLogged(prompt: string)`.

- [ ] **Step 1: Write the failing test**

`apps/web/lib/agent/event-recorder.test.ts` — inject a fake appender to keep this a pure unit test:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@paco/agent-backend";
import { TurnEventRecorder } from "./event-recorder";

function collectingAppender() {
  const batches: SessionEvent[][] = [];
  const append = mock((_chatId: string, events: SessionEvent[]) => {
    batches.push(events);
    return Promise.resolve();
  });
  return { batches, append };
}

describe("TurnEventRecorder", () => {
  test("start logs turn/start and user/message; assertPromptLogged passes", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "hello", policy: "steer" });
    expect(batches[0]!.map((e) => e.type)).toEqual(["turn/start", "user/message"]);
    expect(() => recorder.assertPromptLogged("hello")).not.toThrow();
    expect(() => recorder.assertPromptLogged("other")).toThrow(/invariant/i);
  });

  test("chunks flush in batches of 50 and on finish", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "p", policy: "steer" });
    for (let i = 0; i < 120; i++) {
      recorder.chunk({ type: "text-delta", id: "t", delta: String(i) });
    }
    await recorder.finish({ finishReason: "stop", isError: false });
    // start batch + two full chunk batches + final batch (20 chunks + turn/end)
    const chunkEvents = batches.flat().filter((e) => e.type === "assistant/chunk");
    expect(chunkEvents).toHaveLength(120);
    const last = batches.at(-1)!;
    expect(last.at(-1)!.type).toBe("turn/end");
  });

  test("finish with usage logs usage/reported before turn/end", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "p", policy: "queue" });
    await recorder.finish({
      finishReason: "stop",
      isError: false,
      usage: {
        inputTokens: 1, outputTokens: 2, cachedInputTokens: 0,
        cacheCreationInputTokens: 0, models: {},
      },
      costUsd: 0.01,
      steered: { text: "go left" },
    });
    const types = batches.flat().map((e) => e.type);
    expect(types.indexOf("usage/reported")).toBeLessThan(types.indexOf("turn/end"));
    const end = batches.flat().find((e) => e.type === "turn/end");
    expect(end).toMatchObject({ steered: { text: "go left" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Implement `event-recorder.ts`**

```ts
import type { SessionEvent, TurnFinishReason, TurnPolicy, TurnUsage } from "@paco/agent-backend";
import { appendSessionEvents } from "@/lib/db/session-events";

type Appender = (chatId: string, events: SessionEvent[]) => Promise<void>;

const CHUNK_FLUSH_SIZE = 50;

/**
 * Batches a turn's session events so chunk volume doesn't turn into row-per-
 * delta insert traffic. All appends go through the never-throwing
 * appendSessionEvents, so recording cannot fail a turn.
 */
export class TurnEventRecorder {
  private readonly chatId: string;
  private readonly turnId: string;
  private readonly append: Appender;
  private pendingChunks: SessionEvent[] = [];
  private loggedPrompt: string | undefined;

  constructor(chatId: string, turnId: string, append: Appender = appendSessionEvents) {
    this.chatId = chatId;
    this.turnId = turnId;
    this.append = append;
  }

  async start(params: { messageId: string; prompt: string; policy: TurnPolicy }): Promise<void> {
    this.loggedPrompt = params.prompt;
    await this.append(this.chatId, [
      {
        type: "turn/start",
        turnId: this.turnId,
        messageId: params.messageId,
        prompt: params.prompt,
        policy: params.policy,
      },
      {
        type: "user/message",
        turnId: this.turnId,
        messageId: params.messageId,
        text: params.prompt,
      },
    ]);
  }

  /**
   * Spec 1a runtime invariant: what is sent to the model must equal what was
   * logged. Called by the workflow just before dispatching the turn.
   */
  assertPromptLogged(prompt: string): void {
    if (this.loggedPrompt !== prompt) {
      throw new Error(
        "session-events invariant violated: the dispatched prompt differs from the logged user/message",
      );
    }
  }

  chunk(chunk: unknown): void {
    this.pendingChunks.push({ type: "assistant/chunk", turnId: this.turnId, chunk });
    if (this.pendingChunks.length >= CHUNK_FLUSH_SIZE) {
      const batch = this.pendingChunks;
      this.pendingChunks = [];
      void this.append(this.chatId, batch);
    }
  }

  async finish(params: {
    finishReason: TurnFinishReason;
    isError: boolean;
    usage?: TurnUsage;
    costUsd?: number;
    steered?: { text: string };
  }): Promise<void> {
    const tail: SessionEvent[] = [...this.pendingChunks];
    this.pendingChunks = [];
    if (params.usage) {
      tail.push({
        type: "usage/reported",
        turnId: this.turnId,
        usage: params.usage,
        ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
      });
    }
    tail.push({
      type: "turn/end",
      turnId: this.turnId,
      finishReason: params.finishReason,
      isError: params.isError,
      ...(params.steered ? { steered: params.steered } : {}),
    });
    await this.append(this.chatId, tail);
  }
}
```

- [ ] **Step 4: Wire it into the workflow step**

In `apps/web/app/workflows/chat.ts`, inside the `"use step"` function that calls `runAgentTurn` (it already receives `chatId`, `prompt`, `messageId`):

1. Before the `runAgentTurn` call: `const recorder = new TurnEventRecorder(chatId, crypto.randomUUID()); await recorder.start({ messageId, prompt, policy: "steer" }); recorder.assertPromptLogged(prompt);` (policy becomes dynamic in Task 10; hardcode `"steer"` for now).
2. In the existing `onChunk` callback, after the writer logic: `recorder.chunk(chunk);`
3. After `runAgentTurn` returns: `await recorder.finish({ finishReason: step.finishReason, isError: step.isError, usage: step.usage, costUsd: step.costUsd, ...(step.steered ? { steered: step.steered } : {}) });`
4. In the `catch` branch for aborts (the `isAbortError(error)` path): `await recorder.finish({ finishReason: "stop", isError: false });`
5. In the error rethrow path: `await recorder.finish({ finishReason: "error", isError: true });`

Note: `step.usage` is `ClaudeRunUsage`, structurally identical to `TurnUsage` — it assigns directly. If TypeScript disagrees, fix the type at the source (`AgentStepResult.usage` should be `TurnUsage` after Task 6), not with a cast.

- [ ] **Step 5: Run tests**

Run: `bun test apps/web/lib/agent/event-recorder.test.ts` → PASS.
Run: `bun test apps/web/app/workflows/chat.test.ts` → existing workflow tests still pass.
Run: `turbo typecheck --filter=web` → clean.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add apps/web/lib/agent apps/web/app/workflows
git commit -m "Record session events for every chat turn"
```

---

### Task 8: Projection + replay equivalence

**Files:**
- Create: `apps/web/lib/chat/derive-from-events.ts`
- Test: `apps/web/lib/chat/derive-from-events.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`, `chunkOf` (Task 1); `readUIMessageStream`, `UIMessage`, `UIMessageChunk` from `ai`.
- Produces: `deriveAssistantMessage(events: SessionEvent[], turnId: string, messageId: string): Promise<UIMessage | undefined>` — replays a turn's `assistant/chunk` events through the same `readUIMessageStream` machinery `run-step.ts` uses, so the projection and the live path share one implementation of "chunks → message".

- [ ] **Step 1: Write the failing test**

`apps/web/lib/chat/derive-from-events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@paco/agent-backend";
import { deriveAssistantMessage } from "./derive-from-events";

const turnChunks = [
  { type: "text-start", id: "txt1" },
  { type: "text-delta", id: "txt1", delta: "Hello " },
  { type: "text-delta", id: "txt1", delta: "world" },
  { type: "text-end", id: "txt1" },
];

function eventsFor(turnId: string): SessionEvent[] {
  return [
    { type: "turn/start", turnId, messageId: "m1", prompt: "greet", policy: "steer" },
    { type: "user/message", turnId, messageId: "m1", text: "greet" },
    ...turnChunks.map((chunk) => ({ type: "assistant/chunk" as const, turnId, chunk })),
    { type: "turn/end", turnId, finishReason: "stop" as const, isError: false },
  ];
}

describe("deriveAssistantMessage", () => {
  test("replays chunks into the assistant message", async () => {
    const message = await deriveAssistantMessage(eventsFor("t1"), "t1", "msg_9");
    expect(message).toBeDefined();
    expect(message!.id).toBe("msg_9");
    expect(message!.role).toBe("assistant");
    const text = message!.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("ignores other turns' chunks", async () => {
    const mixed = [...eventsFor("t1"), ...eventsFor("t2")];
    const message = await deriveAssistantMessage(mixed, "t2", "msg_2");
    const text = message!.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("returns undefined for a turn with no chunks", async () => {
    const events: SessionEvent[] = [
      { type: "turn/start", turnId: "t3", messageId: "m", prompt: "p", policy: "steer" },
      { type: "turn/end", turnId: "t3", finishReason: "stop", isError: false },
    ];
    expect(await deriveAssistantMessage(events, "t3", "m")).toBeUndefined();
  });

  test("REPLAY EQUIVALENCE: derived message equals the live-path message", async () => {
    // The live path: feed the same chunks through readUIMessageStream the way
    // run-step.ts does, stamp the id, compare deep-equal with the derivation.
    const { readUIMessageStream } = await import("ai");
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of turnChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    let live: unknown;
    for await (const m of readUIMessageStream({ stream })) {
      live = m;
    }
    const liveStamped = { ...(live as { parts: unknown[] }), id: "msg_eq" };
    const derived = await deriveAssistantMessage(eventsFor("t1"), "t1", "msg_eq");
    expect(derived).toEqual(liveStamped as never);
  });
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: Implement**

```ts
import { chunkOf, type SessionEvent } from "@paco/agent-backend";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

/**
 * Project a turn's assistant message from the event log.
 *
 * Same machinery as the live path in run-step.ts (readUIMessageStream over
 * the chunk sequence, then stamp the caller's message id), which is what
 * makes the replay-equivalence test meaningful: one implementation of
 * "chunks → message", two feeders.
 */
export async function deriveAssistantMessage(
  events: SessionEvent[],
  turnId: string,
  messageId: string,
): Promise<UIMessage | undefined> {
  const chunks: UIMessageChunk[] = [];
  for (const event of events) {
    if (event.type === "assistant/chunk" && event.turnId === turnId) {
      chunks.push(chunkOf(event));
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }

  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) {
    message = m;
  }
  return message ? { ...message, id: messageId } : undefined;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `bun test apps/web/lib/chat/derive-from-events.test.ts` → PASS (4 tests — equivalence is the one that matters).
Run: `turbo typecheck --filter=web` → clean. `pnpm fix`.

```bash
git add apps/web/lib/chat
git commit -m "Project assistant messages from the event log, with replay-equivalence test"
```

---

### Task 9: Turn policy column + steer-request API path

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (chats table)
- Create: migration via `pnpm --dir apps/web db:generate`
- Modify: the chat message-send API route (find it: `grep -rn "activeStreamId" apps/web/app/api --include='*.ts'` — the handler that rejects or conflicts when a stream is active)
- Test: colocated test next to the modified route/helper, following that file's existing test pattern

**Interfaces:**
- Consumes: `appendSessionEvents` (Task 2), `turnPolicySchema` (Task 1).
- Produces: `chats.turnPolicy` column (`text`, enum `["steer", "queue"]`, notNull, default `"steer"`); an API behavior: a message posted while a turn is active is **accepted** (HTTP 200-family) and recorded as `steer/buffered` instead of being rejected.

- [ ] **Step 1: Schema + migration**

In the `chats` table definition add after `effort`:

```ts
    /**
     * What happens when a message arrives while a turn is running.
     * "steer": buffer durably, cancel the active turn, continue with the
     * buffered message. "queue": buffer durably, run it after the turn ends.
     * (Spec 1c; both consume from the same steer/buffered events.)
     */
    turnPolicy: text("turn_policy", { enum: ["steer", "queue"] })
      .notNull()
      .default("steer"),
```

Run `pnpm --dir apps/web db:generate`; inspect and keep the `.sql`.

- [ ] **Step 2: Find the active-turn rejection path**

Run the grep above plus `grep -rn "conflict" apps/web/app/api/chat --include='*.ts' -il`. Read the handler. Today a send during an active stream either 409s or is dropped — identify the exact branch.

- [ ] **Step 3: Write the failing test** for the new behavior, in that handler's existing test style: posting a message while `activeStreamId` is set on the chat MUST (a) return success, (b) append exactly one `steer/buffered` event whose `text` is the message text and whose `messageId` is the posted message's id, (c) NOT start a second workflow run. Both policies buffer identically at this layer (the difference is who consumes, Task 10) — assert the event exists for a `turnPolicy: "queue"` chat too.

- [ ] **Step 4: Implement** — in the identified branch, replace the reject/drop with: persist the user message row as usual (it must appear in the chat), `await appendSessionEvents(chatId, [{ type: "steer/buffered", messageId, text }])`, return success WITHOUT starting a workflow. Leave every not-active-turn path untouched.

- [ ] **Step 5: Run tests** — the new test plus the route's existing tests. `turbo typecheck --filter=web`.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add apps/web/lib/db apps/web/app/api
git commit -m "Buffer mid-turn messages as steer/buffered instead of rejecting"
```

---

### Task 10: Steer monitor + continuation turns

**Files:**
- Modify: `apps/web/app/workflows/chat.ts`
- Test: extend `apps/web/app/workflows/chat.test.ts` (follow its existing fixture pattern)

**Interfaces:**
- Consumes: `listUnconsumedSteerEvents`, `appendSessionEvents` (Task 2); `runAgentTurn`'s `steered` result (Task 6); chat's `turnPolicy` (Task 9); the existing `startStopMonitor` pattern (`apps/web/app/workflows/chat.ts:1109`).
- Produces: steering end-to-end — a buffered message cancels (steer) or follows (queue) the active turn, exactly once, recorded as `steer/consumed`.

- [ ] **Step 1: Read `startStopMonitor`** (chat.ts:1109-1140) and the workflow's multi-step loop structure (how `runAgentWorkflow` sequences steps and what happens after `stepWasAborted`).

- [ ] **Step 2: Write failing tests** in the workflow's existing test style:

```ts
// Test A (steer): chat with turnPolicy "steer"; start a turn against a
// FakeBackend-driven runAgentTurn (or the file's existing turn fixture);
// append a steer/buffered event mid-turn; assert the turn is aborted, a
// continuation turn runs with prompt === the buffered text, exactly one
// steer/consumed {mode:"steer"} event is appended, and the continuation
// reuses the chat's claudeSessionId (resume).
// Test B (queue): same setup with turnPolicy "queue"; assert the first turn
// runs to completion untouched, then a follow-up turn runs with the buffered
// text and steer/consumed {mode:"queue"} is appended.
// Test C (no double consumption): two buffered messages during one turn are
// consumed once each, in order, as separate continuation turns.
```

- [ ] **Step 3: Implement the monitor**

Add beside `startStopMonitor`, following its polling/cleanup shape exactly:

```ts
/**
 * Polls for steer/buffered events during a turn (steer policy only) and
 * aborts the in-flight turn when one arrives; the workflow loop then consumes
 * the buffer as a continuation turn. Same lifecycle as startStopMonitor.
 */
function startSteerMonitor(
  chatId: string,
  abortController: AbortController,
  onSteerDetected: () => void,
) {
  let shouldStop = false;
  const poll = async () => {
    while (!shouldStop && !abortController.signal.aborted) {
      try {
        const pending = await listUnconsumedSteerEvents(chatId);
        if (pending.length > 0) {
          onSteerDetected();
          abortController.abort();
          return;
        }
      } catch {
        // Polling must never kill a turn; try again next tick.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  void poll();
  return { stop: () => { shouldStop = true; } };
}
```

- [ ] **Step 4: Wire the loop**

In the `"use step"` turn function: read the chat's `turnPolicy`; when `"steer"`, start the steer monitor alongside the stop monitor (and stop it in the same `finally`); track `steerDetected` via the callback so the abort-catch branch can distinguish steer-abort (return `stepWasAborted: false` plus a `stepWasSteered: true` flag on the step result) from user-stop.

In `runAgentWorkflow`'s sequencing, after a step completes (any policy) or was steered:

```ts
// Consume buffered messages as continuation turns, oldest first, exactly once.
let pending = await listUnconsumedSteerEvents(chatId);
while (pending.length > 0) {
  const next = pending[0]!;
  await appendSessionEvents(chatId, [
    { type: "steer/consumed", messageId: next.messageId, mode: turnPolicy },
  ]);
  /* run one more turn with prompt = next.text, same chat, resuming
     claudeSessionId — reuse the exact same step invocation the primary turn
     used, including recorder start/finish (Task 7) and checkpointing. */
  pending = await listUnconsumedSteerEvents(chatId);
}
```

The consumed event is appended BEFORE the continuation turn runs: a crash between the two loses the buffered message rather than double-running it, and durable-workflow replay of the step would otherwise re-consume. Note the asymmetry with the invariant is deliberate: the message is still in `chatMessages` (Task 9 persisted it), so nothing is lost from history — only from auto-continuation.

- [ ] **Step 5: Run tests**

Run: `bun test apps/web/app/workflows/chat.test.ts` → new tests A/B/C plus all existing tests pass.
Run: `turbo typecheck --filter=web` → clean.

- [ ] **Step 6: Commit**

```bash
pnpm fix
git add apps/web/app/workflows
git commit -m "Steer and queue turn policies over buffered steer events"
```

---

## Final verification (after Task 10, before the branch review)

- [ ] Run `pnpm run ci` at the repo root — format, lint, typecheck, full suite. Fix anything it surfaces.
- [ ] Run `bun test packages/agent-backend packages/claude-code` once more — the conformance suite is the seam's contract; it must be green on both backends (Fake, ClaudeCode-with-stub).
