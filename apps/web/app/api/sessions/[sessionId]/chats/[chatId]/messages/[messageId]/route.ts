import { getRun } from "workflow/api";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import {
  deleteChatMessageAndFollowing,
  updateChatActiveStreamId,
} from "@/lib/db/sessions";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string; messageId: string }>;
};

export async function DELETE(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }
  const { sessionId, chatId, messageId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const { chat } = chatContext;

  if (chat.activeStreamId) {
    // Check if the workflow is actually still running. If it terminated
    // without cleaning up (e.g. due to a failure), clear the stale ID
    // and allow the delete to proceed.
    try {
      const run = getRun(chat.activeStreamId);
      const status = await run.status;
      if (status === "running" || status === "pending") {
        return Response.json(
          {
            error:
              "Paco is still replying. Wait for it to finish, or press Stop.",
          },
          { status: 409 },
        );
      }
    } catch {
      // Workflow run not found — treat as stale.
    }

    // Workflow is terminal or not found — clear the stale activeStreamId.
    await updateChatActiveStreamId(chatId, null);
  }

  const result = await deleteChatMessageAndFollowing(chatId, messageId);

  if (result.status === "not_found") {
    return Response.json(
      { error: "We couldn't find that message. It may have been deleted." },
      { status: 404 },
    );
  }

  if (result.status === "not_user_message") {
    return Response.json(
      { error: "You can only delete your own messages." },
      { status: 400 },
    );
  }

  return Response.json({
    success: true,
    deletedMessageIds: result.deletedMessageIds,
  });
}
