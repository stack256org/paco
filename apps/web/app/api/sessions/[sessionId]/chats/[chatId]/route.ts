import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import {
  CHAT_DELETE_BLOCKED,
  CHAT_DELETE_NEEDS_WORKSPACE,
  removeChatWorktree,
} from "@/lib/sandbox/chat-worktree-removal";
import type { WebAgentUIMessage } from "@/app/types";
import { capabilitiesForBackend } from "@/lib/agent/backend-capabilities";
import type { ChatBackendId } from "@/lib/agent/backend-factory";
import {
  deleteChat,
  getChatMessages,
  getChatsBySessionId,
  updateChat,
} from "@/lib/db/sessions";
import { type Effort, parseEffort } from "@/lib/effort";
import { BAD_REQUEST, CHAT_NOT_FOUND } from "@/lib/error-copy";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

/** `chats.backend`'s enum — see `schema.ts` and `backend-factory.ts`. */
const KNOWN_CHAT_BACKENDS: ReadonlySet<string> = new Set<ChatBackendId>([
  "claude-code",
  "openfx",
]);

interface UpdateChatRequest {
  title?: string;
  modelId?: string;
  /**
   * Reasoning effort. `null` is meaningful — it clears the override so the
   * model uses its own default — so it is distinguished from an absent field.
   */
  effort?: string | null;
  /** Which `AgentBackend` this chat's turns run on — `chats.backend`. */
  backend?: string;
}

export interface ChatRefreshResponse {
  chat: {
    id: string;
    modelId: string | null;
    effort: Effort | null;
    activeStreamId: string | null;
  };
  isStreaming: boolean;
  messages: WebAgentUIMessage[];
}

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const messages = await getChatMessages(chatId);
  const modelId = chatContext.chat.modelId ?? null;

  return Response.json({
    chat: {
      id: chatContext.chat.id,
      modelId,
      effort: chatContext.chat.effort ?? null,
      activeStreamId: chatContext.chat.activeStreamId,
    },
    isStreaming: chatContext.chat.activeStreamId !== null,
    messages: messages.map((message) => message.parts as WebAgentUIMessage),
  } satisfies ChatRefreshResponse);
}

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  let body: UpdateChatRequest;
  try {
    body = (await req.json()) as UpdateChatRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const nextTitle = body.title?.trim();
  const nextModelId = body.modelId?.trim();
  const hasEffort = "effort" in body;
  const nextBackend = body.backend?.trim();

  if (nextBackend && !KNOWN_CHAT_BACKENDS.has(nextBackend)) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  if (!(nextTitle || nextModelId || hasEffort || nextBackend)) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const updatePayload: {
    title?: string;
    modelId?: string;
    effort?: Effort | null;
    backend?: ChatBackendId;
  } = {};
  if (nextTitle) {
    updatePayload.title = nextTitle;
  }
  if (nextModelId) {
    updatePayload.modelId = nextModelId;
  }
  if (hasEffort) {
    // Anything unrecognised becomes null rather than 400: the only values the
    // picker can send are known, and a stale client should fall back to the
    // model default rather than fail to save.
    updatePayload.effort = parseEffort(body.effort);
  }
  if (nextBackend) {
    updatePayload.backend = nextBackend as ChatBackendId;
  }

  const updatedChat = await updateChat(chatId, updatePayload);
  if (!updatedChat) {
    return Response.json({ error: CHAT_NOT_FOUND }, { status: 404 });
  }

  return Response.json({
    chat: {
      ...updatedChat,
      modelId: updatedChat.modelId,
      // Recomputed from the row that was just written, not the client's
      // patch: `resolveBackend`'s own fallback rule (unknown -> claude-code)
      // is exactly what a stale/rejected `backend` value should read as
      // here too.
      capabilities: capabilitiesForBackend(updatedChat.backend),
    },
  });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const chats = await getChatsBySessionId(sessionId);
  if (chats.length <= 1) {
    return Response.json(
      {
        error:
          "A session needs at least one chat, so this one can't be deleted.",
      },
      { status: 400 },
    );
  }

  /*
   * The files go before the row, not after.
   *
   * `removeChatWorktree` (`lib/sandbox/chat-worktree-removal.ts`) has existed
   * since worktrees did and was called from nothing but an integration test,
   * so every deleted chat left its worktree on disk — unreachable, and
   * missed by the orphan sweep, which looks for whole workspaces rather than
   * worktrees inside one.
   *
   * Removing first means a failure leaves the chat visible and deletable
   * again, instead of producing a directory with nothing pointing at it. The
   * branch is deliberately kept: deleting a chat should free disk, not discard
   * commits.
   */
  const removal = await removeChatWorktree(
    chatContext.sessionRecord.sandboxState,
    chatId,
  );

  if (removal.kind === "not-running") {
    return Response.json(
      { error: CHAT_DELETE_NEEDS_WORKSPACE },
      { status: 409 },
    );
  }

  if (removal.kind === "failed") {
    console.error(
      `[chat ${chatId}] worktree removal failed: ${removal.reason}`,
    );
    return Response.json({ error: CHAT_DELETE_BLOCKED }, { status: 409 });
  }

  await deleteChat(chatId);
  return Response.json({ success: true });
}
