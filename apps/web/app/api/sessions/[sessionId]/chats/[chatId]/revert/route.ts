import { connectSandbox } from "@paco/sandbox";
import { z } from "zod";
import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getSessionById } from "@/lib/db/sessions";
import { restoreCheckpoint } from "@/lib/git/checkpoint";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { BAD_REQUEST } from "@/lib/error-copy";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

const bodySchema = z.object({
  // A full or abbreviated sha. Validated as hex so it cannot carry anything
  // that would change the meaning of the git command it is spliced into.
  checkpointSha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "Not a commit sha"),
});

/**
 * Undo an agent turn by returning the worktree to its pre-turn checkpoint.
 *
 * What "undo this turn" means, exactly — the client must say all of this in
 * its confirmation, because every line of it is destructive:
 *
 * - **The working tree goes back to the moment before that turn started.**
 *   Not a reverse-patch of the turn: a whole-tree restore. Files it created
 *   are deleted, files it deleted come back, files it rewrote are restored,
 *   and untracked files are included in all three.
 * - **Everything done after that turn goes too.** Later turns, and anything
 *   the operator edited by hand since. There is no honest way to lift one
 *   turn out of the middle of a stack of edits to the same files, and
 *   pretending otherwise would silently keep half of a later change.
 * - **The staging area is replaced** by the one the checkpoint recorded. What
 *   is staged now is not preserved; what was staged then comes back.
 * - **Commits are untouched.** The branch does not move, so anything the
 *   operator has committed survives an undo completely. That is the point of
 *   committing being an explicit act: it is the line past which undo cannot
 *   reach.
 * - **Ignored files are untouched.** Build output and dependencies were never
 *   captured, so they are never deleted.
 *
 * The snapshot lives under `refs/paco/turns/<chatId>/…`, outside `refs/heads`,
 * so none of this ever put a commit on the operator's branch.
 */
export async function POST(request: Request, context: RouteContext) {
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

  // Reverting under a turn that is still writing would race the agent and
  // leave a half-reverted tree.
  if (chatContext.chat.activeStreamId) {
    return Response.json(
      { error: "The agent is still working. Stop it first, then revert." },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const session = await getSessionById(sessionId);
  if (!(session?.sandboxState && isSandboxActive(session.sandboxState))) {
    return Response.json(
      {
        error: "This workspace is asleep. Choose Resume to wake it, then undo.",
      },
      { status: 409 },
    );
  }

  const sandbox = await connectSandbox(session.sandboxState);
  const cwd = resolveWorkCwd(session.sandboxState, chatId);

  const result = await restoreCheckpoint(
    sandbox,
    cwd,
    parsed.data.checkpointSha,
  );
  if (!result.ok) {
    return Response.json(
      { error: result.message },
      { status: result.reason === "unknown-checkpoint" ? 410 : 500 },
    );
  }

  return Response.json({ ok: true });
}
