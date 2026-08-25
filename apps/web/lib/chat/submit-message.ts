import "server-only";

import { generateId, type InferUIMessageChunk } from "ai";
import { start } from "workflow/api";
import { persistAssistantMessagesWithToolResults } from "@/app/api/chat/_lib/persist-tool-results";
import type { WebAgentUIMessage } from "@/app/types";
import { runAgentWorkflow } from "@/app/workflows/chat";
import { createCancelableReadableStream } from "@/lib/chat/create-cancelable-readable-stream";
import {
  claimChatActiveStreamId,
  compareAndSetChatActiveStreamId,
  createChatMessageIfNotExists,
  getChatById,
  isFirstChatMessage,
  touchChat,
  updateChat,
} from "@/lib/db/sessions";
import { appendSessionEventsStrict } from "@/lib/db/session-events";
import type { Session } from "@/lib/session/types";

export type SubmitMessageUIMessageChunk =
  InferUIMessageChunk<WebAgentUIMessage>;

/** The browser chat route's long-standing turn cap, used when a caller omits `maxSteps`. */
const DEFAULT_MAX_STEPS = 500;

export interface SubmitMessageInput {
  chatId: string;
  sessionId: string;
  userId: string;
  messages: WebAgentUIMessage[];
  requestUrl: string;
  /** `null` for a submission with no interactive user behind it (e.g. a plugin). */
  authSession: Session | null;
  /** The owning session's lifecycle status, as already loaded by the caller. */
  sessionStatus: string;
  /** The chat row's current `activeStreamId`, as already loaded by the caller. */
  activeStreamId: string | null;
  /**
   * The executor turn cap passed to the CLI as `--max-turns`. Defaults to
   * 500 — the browser chat route's own long-standing limit — so existing
   * callers see no change; a caller starting an unattended run (e.g. the
   * task board) can pass a tighter cap instead.
   */
  maxSteps?: number;
  /**
   * Runs this turn as a design turn — N parallel designer candidates in
   * their own worktrees — instead of one turn on the chat's branch. Set per
   * message by the composer's Design toggle, never stored on the chat.
   */
  mode?: "design";
  /** How many candidates a design turn runs. Validated by the caller. */
  designCandidateCount?: 2 | 3;
  /** Refine that one existing candidate instead of generating a fresh set. */
  designIterateCandidate?: 1 | 2 | 3;
}

export type SubmitMessageOutcome =
  | { kind: "archived" }
  | { kind: "buffer-failed" }
  | { kind: "conflict" }
  | {
      kind: "streaming";
      runId: string;
      stream: ReadableStream<SubmitMessageUIMessageChunk>;
    };

/**
 * The one place a message is ever submitted into a chat's turn machinery.
 *
 * This is the exact logic the chat API route (`app/api/chat/route.ts`) runs
 * for a browser-submitted message, extracted so `messages:post`
 * (`lib/plugins/capability-handlers.ts`) can post a plugin-originated message
 * through the identical path — including landing as a durable
 * `steer/buffered` event for free when a turn is already active (spec
 * Section 1 Task 9 behavior), rather than a second, drifting implementation
 * of "what happens when a message arrives".
 *
 * Callers supply `sessionStatus`/`activeStreamId` rather than record objects:
 * the route already has them from its own ownership check, and re-deriving
 * them here would mean querying twice for the one caller (the route) that
 * already paid for the query.
 */
export async function submitChatMessage(
  input: SubmitMessageInput,
): Promise<SubmitMessageOutcome> {
  const {
    chatId,
    sessionId,
    userId,
    messages,
    requestUrl,
    authSession,
    sessionStatus,
    activeStreamId,
    maxSteps = DEFAULT_MAX_STEPS,
    mode,
    designCandidateCount,
    designIterateCandidate,
  } = input;

  if (sessionStatus === "archived") {
    return { kind: "archived" };
  }

  // Guard: if a workflow is already running for this chat, reconnect to it
  // instead of starting a duplicate. This prevents auto-submit from spawning
  // parallel workflows when the client sees completed tool calls mid-loop.
  //
  // If the request that reconnects us is itself a new user message (as
  // opposed to an assistant tool-result auto-submit continuing the same
  // turn), also record it as a durable steer/buffered event before
  // reconnecting — the consumer decides whether that buffered message
  // cancels (steer) or waits out (queue) the turn we are joining here.
  if (activeStreamId) {
    const existingStreamResolution = await reconcileExistingActiveStream(
      chatId,
      activeStreamId,
    );

    if (existingStreamResolution.action === "resume") {
      const buffered = await bufferMidTurnMessage(chatId, messages);
      if (!buffered.ok) {
        return { kind: "buffer-failed" };
      }

      return {
        kind: "streaming",
        runId: existingStreamResolution.runId,
        stream: existingStreamResolution.stream,
      };
    }

    if (existingStreamResolution.action === "conflict") {
      return { kind: "conflict" };
    }
  }

  await Promise.all([
    persistLatestUserMessage(chatId, messages),
    persistAssistantMessagesWithToolResults(chatId, messages),
  ]);

  // Start the durable workflow
  const run = await start(runAgentWorkflow, [
    {
      messages,
      chatId,
      sessionId,
      userId,
      requestUrl,
      authSession,
      assistantId: generateId(),
      maxSteps,
      ...(mode ? { mode } : {}),
      ...(designCandidateCount ? { designCandidateCount } : {}),
      ...(designIterateCandidate ? { designIterateCandidate } : {}),
    },
  ]);

  // Idempotently claim the activeStreamId slot for the workflow we just
  // started. This succeeds both when the slot is still null and when the
  // workflow already self-claimed it from inside its first step.
  const claimed = await claimChatActiveStreamId(chatId, run.runId);

  if (!claimed) {
    // Another request or workflow run owns the slot — cancel our duplicate.
    try {
      const { getRun } = await import("workflow/api");
      getRun(run.runId).cancel();
    } catch {
      // Best-effort cleanup.
    }
    return { kind: "conflict" };
  }

  const stream = createCancelableReadableStream(
    run.getReadable<SubmitMessageUIMessageChunk>(),
  );

  return { kind: "streaming", runId: run.runId, stream };
}

type ExistingActiveStreamResolution =
  | {
      action: "resume";
      runId: string;
      stream: ReadableStream<SubmitMessageUIMessageChunk>;
    }
  | {
      action: "ready";
    }
  | {
      action: "conflict";
    };

const ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS = 3;

async function reconcileExistingActiveStream(
  chatId: string,
  activeStreamId: string,
): Promise<ExistingActiveStreamResolution> {
  const { getRun } = await import("workflow/api");
  let currentStreamId: string | null = activeStreamId;

  for (
    let attempt = 1;
    currentStreamId && attempt <= ACTIVE_STREAM_RECONCILIATION_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      const existingRun = getRun(currentStreamId);
      const status = await existingRun.status;
      if (status === "running" || status === "pending") {
        return {
          action: "resume",
          runId: currentStreamId,
          stream: createCancelableReadableStream(
            existingRun.getReadable<SubmitMessageUIMessageChunk>(),
          ),
        };
      }
    } catch {
      // Workflow not found or inaccessible — try to clear the stale stream ID.
    }

    const cleared = await compareAndSetChatActiveStreamId(
      chatId,
      currentStreamId,
      null,
    );
    if (cleared) {
      return { action: "ready" };
    }

    const latestChat = await getChatById(chatId);
    currentStreamId = latestChat?.activeStreamId ?? null;
  }

  return currentStreamId ? { action: "conflict" } : { action: "ready" };
}

/**
 * If the request reconnecting us to the active turn ends in a new user
 * message (rather than an assistant tool-result auto-submit), persist that
 * message and record it as a durable steer/buffered event. Both turnPolicy
 * values buffer identically here — which one cancels vs. queues the active
 * turn is decided by the consumer.
 *
 * The append must not be silently lossy: it uses the strict variant so a DB
 * failure surfaces to the caller instead of being swallowed while the caller
 * is told its message was saved.
 */
async function bufferMidTurnMessage(
  chatId: string,
  messages: WebAgentUIMessage[],
): Promise<{ ok: true } | { ok: false }> {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage || latestMessage.role !== "user") {
    return { ok: true };
  }

  await persistLatestUserMessage(chatId, messages);

  try {
    await appendSessionEventsStrict(chatId, [
      {
        type: "steer/buffered",
        messageId: latestMessage.id,
        text: extractMessageText(latestMessage),
      },
    ]);
  } catch (error) {
    console.error("Failed to append steer/buffered event:", error);
    return { ok: false };
  }

  return { ok: true };
}

function extractMessageText(message: WebAgentUIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join(" ")
    .trim();
}

async function persistLatestUserMessage(
  chatId: string,
  messages: WebAgentUIMessage[],
): Promise<void> {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage || latestMessage.role !== "user") {
    return;
  }

  try {
    const created = await createChatMessageIfNotExists({
      id: latestMessage.id,
      chatId,
      role: "user",
      parts: latestMessage,
    });

    if (!created) {
      return;
    }

    await touchChat(chatId);

    const shouldSetTitle = await isFirstChatMessage(chatId, created.id);
    if (!shouldSetTitle) {
      return;
    }

    const textContent = extractMessageText(latestMessage);

    if (textContent.length === 0) {
      return;
    }

    const title =
      textContent.length > 80 ? `${textContent.slice(0, 80)}...` : textContent;
    await updateChat(chatId, { title });
  } catch (error) {
    console.error("Failed to persist user message:", error);
  }
}
