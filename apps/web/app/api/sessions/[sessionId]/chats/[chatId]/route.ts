import { chatDir, connectSandbox, repoDir } from "@paco/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import {
  CHAT_DELETE_BLOCKED,
  CHAT_DELETE_NEEDS_WORKSPACE,
  classifyWorktreeRemoval,
} from "@/lib/sandbox/chat-worktree-removal";
import { canOperateOnSandbox } from "@/lib/sandbox/utils";
import type { WebAgentUIMessage } from "@/app/types";
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

interface UpdateChatRequest {
  title?: string;
  modelId?: string;
  /**
   * Reasoning effort. `null` is meaningful — it clears the override so the
   * model uses its own default — so it is distinguished from an absent field.
   */
  effort?: string | null;
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

  if (!(nextTitle || nextModelId || hasEffort)) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const updatePayload: {
    title?: string;
    modelId?: string;
    effort?: Effort | null;
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

  const updatedChat = await updateChat(chatId, updatePayload);
  if (!updatedChat) {
    return Response.json({ error: CHAT_NOT_FOUND }, { status: 404 });
  }

  return Response.json({
    chat: {
      ...updatedChat,
      modelId: updatedChat.modelId,
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
   * `removeChatWorktree` has existed since worktrees did and was called from
   * nothing but an integration test, so every deleted chat left its worktree
   * on disk — unreachable, and missed by the orphan sweep, which looks for
   * whole workspaces rather than worktrees inside one.
   *
   * Removing first means a failure leaves the chat visible and deletable
   * again, instead of producing a directory with nothing pointing at it. The
   * branch is deliberately kept: deleting a chat should free disk, not discard
   * commits.
   */
  const state = chatContext.sessionRecord.sandboxState;

  if (!canOperateOnSandbox(state)) {
    return Response.json(
      { error: CHAT_DELETE_NEEDS_WORKSPACE },
      { status: 409 },
    );
  }

  try {
    const sandbox = await connectSandbox(state);
    const workspaceRoot = hostWorkspaceFor(state);
    const repo = repoDir(workspaceRoot);

    const removal = classifyWorktreeRemoval(
      await sandbox.exec(
        `git worktree remove --force ${JSON.stringify(chatDir(workspaceRoot, chatId))}`,
        repo,
        30_000,
      ),
    );

    if (removal.kind === "failed") {
      console.error(
        `[chat ${chatId}] worktree removal failed: ${removal.reason}`,
      );
      return Response.json({ error: CHAT_DELETE_BLOCKED }, { status: 409 });
    }

    // Drops the administrative entry the removed worktree left in the
    // repository, so a chat id can be reused and `git worktree list` stays
    // truthful.
    await sandbox.exec("git worktree prune", repo, 30_000);
  } catch (error) {
    console.error(`[chat ${chatId}] worktree removal errored:`, error);
    return Response.json({ error: CHAT_DELETE_BLOCKED }, { status: 409 });
  }

  await deleteChat(chatId);
  return Response.json({ success: true });
}
