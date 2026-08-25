"use server";

import { chatBranchName } from "@paco/sandbox";
import type { WebAgentUIMessage } from "@/app/types";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import {
  createChatMessage,
  getChatById,
  getSessionById,
  touchChat,
} from "@/lib/db/sessions";
import { acceptCandidate, removeCandidates } from "@/lib/design/candidates";
import {
  CHAT_NOT_FOUND,
  NOT_YOURS,
  SESSION_NOT_FOUND,
  SIGNED_OUT,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";
import { getMemberRole } from "@/lib/org/membership";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  type AcceptDesignInput,
  acceptDesignInputSchema,
  type DesignChatTarget,
  designChatTargetSchema,
} from "./design-action-schemas";

/**
 * The gate both design actions re-check, independently.
 *
 * Session ownership plus organisation membership, the same pair
 * `requireEvalAccess` (`app/sessions/[sessionId]/evals/actions.ts`) uses and
 * for the same reason: a chat has no owner column of its own, so ownership
 * is the session it belongs to, and these actions run git against a shared
 * workspace on behalf of an organisation rather than on the session owner's
 * private say-so alone.
 *
 * The chat is re-checked against the session it claims to belong to. Without
 * that, a caller who owns *any* session could pass their own `sessionId`
 * with someone else's `chatId` and have the workspace path resolved from one
 * and the candidate branches from the other.
 */
async function requireDesignAccess(sessionId: string, chatId: string) {
  const authSession = await getServerSession();
  if (!authSession?.user?.id) {
    throw new Error(SIGNED_OUT);
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (session.userId !== authSession.user.id) {
    throw new Error(NOT_YOURS);
  }

  const chat = await getChatById(chatId);
  if (!chat) {
    throw new Error(CHAT_NOT_FOUND);
  }
  if (chat.sessionId !== sessionId) {
    throw new Error(NOT_YOURS);
  }

  const role = await getMemberRole(authSession.user.id);
  if (!role) {
    throw new Error(NOT_YOURS);
  }

  return { session, chat };
}

/**
 * The session's workspace root on the host, or `null` when there is not one
 * yet — a session whose workspace never started has no worktrees at all, so
 * there is nothing for either action to merge or remove.
 */
function workspaceRootFor(session: { sandboxState: unknown }): string | null {
  if (!session.sandboxState) {
    return null;
  }
  try {
    return hostWorkspaceFor(
      session.sandboxState as Parameters<typeof hostWorkspaceFor>[0],
    );
  } catch {
    return null;
  }
}

export type AcceptDesignResult =
  | { success: true; message: WebAgentUIMessage }
  | { success: false; error: string };

/**
 * Adopt one design candidate: merge its branch into the chat's own, announce
 * it in the chat, and remove every candidate.
 *
 * The merge and the cleanup are `acceptCandidate`'s job (Task 1), including
 * its refusals — a dirty chat worktree or a conflicting merge comes back as
 * `{ ok: false }` with candidates deliberately left in place, and this
 * returns that reason verbatim rather than inventing softer copy for a
 * situation the user has to resolve by hand.
 *
 * The announcement is persisted *and* returned: the transcript is a live
 * client-side `useChat` list, so a row written behind its back would not
 * appear until the next page load.
 */
export async function acceptDesignAction(
  input: AcceptDesignInput,
): Promise<AcceptDesignResult> {
  const { sessionId, chatId, index } = acceptDesignInputSchema.parse(input);
  const { session } = await requireDesignAccess(sessionId, chatId);

  const sessionWorkspace = workspaceRootFor(session);
  if (!sessionWorkspace) {
    return { success: false, error: WORKSPACE_NOT_STARTED };
  }

  const chatBranch = chatBranchName(chatId);
  const merged = await acceptCandidate({
    sessionWorkspace,
    chatId,
    index,
    chatBranch,
  });
  if (!merged.ok) {
    return { success: false, error: merged.error };
  }

  const message: WebAgentUIMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `Adopted design candidate ${index}. Its work is merged into \`${chatBranch}\`, and the other candidates have been removed.`,
      },
    ],
  };

  await createChatMessage({
    id: message.id,
    chatId,
    role: "assistant",
    parts: message,
  });
  await touchChat(chatId);

  return { success: true, message };
}

export type CancelDesignResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Throw away every candidate for a chat without adopting any of them.
 *
 * `removeCandidates` is idempotent and tolerates a candidate that was never
 * created, so pressing this twice — or pressing it after a design turn that
 * already cleaned up after itself — is a no-op rather than an error.
 */
export async function cancelDesignAction(
  input: DesignChatTarget,
): Promise<CancelDesignResult> {
  const { sessionId, chatId } = designChatTargetSchema.parse(input);
  const { session } = await requireDesignAccess(sessionId, chatId);

  const sessionWorkspace = workspaceRootFor(session);
  if (!sessionWorkspace) {
    return { success: true };
  }

  try {
    await removeCandidates({ sessionWorkspace, chatId });
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "We couldn't remove the design candidates. Try again in a moment.",
    };
  }

  return { success: true };
}
