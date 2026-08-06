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
 * Destructive: everything after the checkpoint goes, including any edits the
 * user made by hand since. The client confirms before calling, and says so.
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
