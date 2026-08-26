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
 * Mirrors apps/web's `TASK_STATUSES` (`lib/db/schema.ts`). This package has
 * no dependency on the web app, so the values are duplicated here rather
 * than imported. A compile-time guard on the app side
 * (`apps/web/lib/db/session-event-enum-guards.ts`) fails the app's
 * typecheck if this list and `TASK_STATUSES` ever disagree — update both
 * together.
 */
const taskStatusSchema = z.enum([
  "todo",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
]);

/**
 * Mirrors apps/web's `TASK_ORIGINS` (`lib/db/schema.ts`) — see the
 * `taskStatusSchema` comment above; the same
 * `apps/web/lib/db/session-event-enum-guards.ts` guard covers this pair
 * too.
 */
const taskOriginSchema = z.enum([
  "user",
  "planner",
  "schedule",
  "channel",
  "reflection",
]);

/**
 * An eval run's terminal statuses — mirrors `Exclude<EvalRunStatus, "running">`
 * from apps/web's `lib/db/schema.ts` (excluding `"running"`: only a
 * finished run is ever logged). Also guarded against drift by
 * `apps/web/lib/db/session-event-enum-guards.ts` — see the
 * `taskStatusSchema` comment above.
 */
const evalRunFinishedStatusSchema = z.enum(["passed", "failed", "error"]);

/**
 * The session event vocabulary.
 *
 * Spec invariant: anything that reaches a model request must be
 * reconstructable from the log. UI-chunk-native backends log tool activity
 * inside `assistant/chunk`; `tool/call` and `tool/result` exist for a
 * backend without a chunk protocol. Both shipped backends take the chunk
 * route — Claude Code natively, Poolside by mapping ACP session updates —
 * so the `tool/*` route currently has no writer. Both are legal; the
 * projection understands the chunk route.
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
  /*
   * What this turn's model request carried BEYOND the prompt: the retrieved
   * memory section (`system-prompt.ts` pushes it straight into the system
   * prompt) and the subagents, skills and MCP servers actually attached to
   * the run. Every one of those is model-visible and none of it is
   * reconstructable from `turn/start`, so without this event a replay
   * rebuilds a turn the model never actually saw.
   *
   * A separate event rather than a field on `turn/start` because the context
   * is only resolved AFTER the turn has been logged as started — moving
   * `turn/start` late enough to carry it would mean a turn aborted while its
   * memory was still loading had no `turn/start` at all.
   *
   * `agents`/`skills`/`mcpServers` are NAMES only. A skill's body is tens of
   * kilobytes and already on disk; what the log has to answer is which ones
   * were attached, not what they said.
   */
  z.object({
    type: z.literal("turn/context"),
    turnId: z.string(),
    memorySection: z.string().optional(),
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
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
  // The three variants below are chat-adjacent, not turn-scoped: a task's
  // lifecycle (and an eval scenario's) spans zero or more turns across its
  // whole life, so none of them carry a `turnId`. They are appended to the
  // chat the task/eval happens to be attached to at the moment they fire
  // (apps/web's `appendSessionEvents`, never-throwing) — and a task's
  // `chatId` is null until it starts, with some tasks (proposals,
  // reflection) never getting one at all, so callers append these ONLY
  // when a chatId exists and skip silently otherwise.
  z.object({
    type: z.literal("task/created"),
    taskId: z.string(),
    title: z.string(),
    origin: taskOriginSchema,
  }),
  z.object({
    type: z.literal("task/status"),
    taskId: z.string(),
    from: taskStatusSchema,
    to: taskStatusSchema,
  }),
  z.object({
    type: z.literal("eval/finished"),
    evalRunId: z.string(),
    scenarioName: z.string(),
    status: evalRunFinishedStatusSchema,
  }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent["type"];

export function isSessionEvent(value: unknown): value is SessionEvent {
  return sessionEventSchema.safeParse(value).success;
}

/** Narrow helper: the chunk payload of an assistant/chunk event. */
export function chunkOf(
  event: SessionEvent & { type: "assistant/chunk" },
): UIMessageChunk {
  return event.chunk as UIMessageChunk;
}
