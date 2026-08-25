import {
  createUIMessageStreamResponse,
  generateId,
  type InferUIMessageChunk,
} from "ai";
import { start } from "workflow/api";
import type { WebAgentUIMessage } from "@/app/types";
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
import { createCancelableReadableStream } from "@/lib/chat/create-cancelable-readable-stream";
import { NOT_YOURS } from "@/lib/error-copy";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "./_lib/chat-context";
import { parseChatRequestBody, requireChatIdentifiers } from "./_lib/request";
import { runAgentWorkflow } from "@/app/workflows/chat";
import { persistAssistantMessagesWithToolResults } from "./_lib/persist-tool-results";

type WebAgentUIMessageChunk = InferUIMessageChunk<WebAgentUIMessage>;

const STILL_WORKING =
  "Paco is still working on your last message. Wait for it to finish, or press Stop.";

const STEER_BUFFER_FAILED = "Couldn't save your message. Try sending it again.";

export async function POST(req: Request) {
  // 1. Validate session
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }
  const userId = authResult.userId;
  const session = await getServerSession();

  const parsedBody = await parseChatRequestBody(req);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const { messages } = parsedBody.body;

  // 2. Require sessionId and chatId to ensure sandbox ownership verification
  const chatIdentifiers = requireChatIdentifiers(parsedBody.body);
  if (!chatIdentifiers.ok) {
    return chatIdentifiers.response;
  }
  const { sessionId, chatId } = chatIdentifiers;

  // 3. Verify session + chat ownership
  const chatContext = await requireOwnedSessionChat({
    userId,
    sessionId,
    chatId,
    forbiddenMessage: NOT_YOURS,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const { sessionRecord, chat } = chatContext;

  if (sessionRecord.status === "archived") {
    return Response.json(
      {
        error:
          "This session is archived. Unarchive it before sending a message.",
      },
      { status: 400 },
    );
  }

  // Guard: if a workflow is already running for this chat, reconnect to it
  // instead of starting a duplicate. This prevents auto-submit from spawning
  // parallel workflows when the client sees completed tool calls mid-loop.
  //
  // If the request that reconnects us is itself a new user message (as
  // opposed to an assistant tool-result auto-submit continuing the same
  // turn), also record it as a durable steer/buffered event before
  // reconnecting — Task 10's consumer decides whether that buffered message
  // cancels (steer) or waits out (queue) the turn we are joining here.
  if (chat.activeStreamId) {
    const existingStreamResolution = await reconcileExistingActiveStream(
      chatId,
      chat.activeStreamId,
    );

    if (existingStreamResolution.action === "resume") {
      const buffered = await bufferMidTurnMessage(chatId, messages);
      if (!buffered.ok) {
        return Response.json({ error: STEER_BUFFER_FAILED }, { status: 503 });
      }

      return createUIMessageStreamResponse({
        stream: existingStreamResolution.stream,
        headers: { "x-workflow-run-id": existingStreamResolution.runId },
      });
    }

    if (existingStreamResolution.action === "conflict") {
      return Response.json({ error: STILL_WORKING }, { status: 409 });
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
      requestUrl: req.url,
      authSession: session ?? null,
      assistantId: generateId(),
      maxSteps: 500,
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
    return Response.json({ error: STILL_WORKING }, { status: 409 });
  }

  const stream = createCancelableReadableStream(
    run.getReadable<WebAgentUIMessageChunk>(),
  );

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "x-workflow-run-id": run.runId,
    },
  });
}

type ExistingActiveStreamResolution =
  | {
      action: "resume";
      runId: string;
      stream: ReadableStream<WebAgentUIMessageChunk>;
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
            existingRun.getReadable<WebAgentUIMessageChunk>(),
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
 * turn is decided by the consumer (Task 10).
 *
 * The append must not be silently lossy: it uses the strict variant so a DB
 * failure surfaces to the caller instead of being swallowed while the client
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
