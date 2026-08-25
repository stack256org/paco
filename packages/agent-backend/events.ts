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
 * than imported — keep the two lists in sync by hand.
 */
const taskStatusSchema = z.enum([
  "todo",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
]);

/** Mirrors apps/web's `TASK_ORIGINS` (`lib/db/schema.ts`) — see above. */
const taskOriginSchema = z.enum([
  "user",
  "planner",
  "schedule",
  "channel",
  "reflection",
]);

/** An eval run's terminal statuses — mirrors `Exclude<EvalRunStatus, "running">`
 * from apps/web's `lib/db/schema.ts` (excluding `"running"`: only a
 * finished run is ever logged). */
const evalRunFinishedStatusSchema = z.enum(["passed", "failed", "error"]);

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
