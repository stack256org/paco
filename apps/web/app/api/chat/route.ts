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
import { appendSessionEvents } from "@/lib/db/session-events";
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

  // Guard: if a turn is already active for this chat, buffer this message as
  // a durable steer/buffered event instead of starting a duplicate workflow.
  // A later turn (Task 10) consumes the buffered event per the chat's
  // turnPolicy — this layer only needs to record it and avoid double-running.
  if (chat.activeStreamId) {
    const existingStreamResolution = await reconcileExistingActiveStream(
      chatId,
      chat.activeStreamId,
    );

    if (existingStreamResolution.action === "active") {
      return bufferMidTurnMessage(chatId, messages);
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
      action: "active";
    }
  | {
      action: "ready";
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
        return { action: "active" };
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

  // Retries exhausted and the slot is still contested — treat it the same as
  // a confirmed-running turn rather than rejecting the message.
  return currentStreamId ? { action: "active" } : { action: "ready" };
}

/**
 * A turn is active for this chat: record the incoming message as a durable
 * steer/buffered event instead of starting a second workflow run. Both
 * turnPolicy values buffer identically here — which one cancels vs. queues
 * the active turn is decided by the consumer (Task 10).
 */
async function bufferMidTurnMessage(
  chatId: string,
  messages: WebAgentUIMessage[],
): Promise<Response> {
  await Promise.all([
    persistLatestUserMessage(chatId, messages),
    persistAssistantMessagesWithToolResults(chatId, messages),
  ]);

  const latestMessage = messages[messages.length - 1];
  if (latestMessage?.role === "user") {
    await appendSessionEvents(chatId, [
      {
        type: "steer/buffered",
        messageId: latestMessage.id,
        text: extractMessageText(latestMessage),
      },
    ]);
  }

  return Response.json({ ok: true });
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
