import { compactSession } from "@paco/claude-code";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getSessionById } from "@/lib/db/sessions";
import { WORKSPACE_ASLEEP } from "@/lib/error-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

/** Compaction rewrites a long history; it can take a while on a big one. */
export const maxDuration = 300;

/**
 * Shrink this chat's context by asking the CLI to compact its session.
 *
 * The CLI owns the conversation history, so this is the only way to reclaim
 * context short of starting a new chat.
 */
export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireAuthenticatedUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: auth.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  // Compacting rewrites the history the running turn is appending to.
  if (chatContext.chat.activeStreamId) {
    return Response.json(
      { error: "The agent is still working. Stop it first, then compact." },
      { status: 409 },
    );
  }

  const claudeSessionId = chatContext.chat.claudeSessionId;
  if (!claudeSessionId) {
    return Response.json(
      {
        error:
          "This chat has not run a turn yet, so there is no context to compact.",
      },
      { status: 409 },
    );
  }

  const session = await getSessionById(sessionId);
  if (!(session?.sandboxState && isSandboxActive(session.sandboxState))) {
    return Response.json({ error: WORKSPACE_ASLEEP }, { status: 409 });
  }

  // The CLI resolves a session id relative to the directory it was created in,
  // so this has to be the chat's own worktree.
  const cwd = resolveWorkCwd(session.sandboxState, chatId);

  const outcome = await compactSession({ sessionId: claudeSessionId, cwd });

  if (!outcome.ok) {
    return Response.json({ error: outcome.reason }, { status: 422 });
  }

  return Response.json({ ok: true, summary: outcome.summary });
}
