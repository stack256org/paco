import { after } from "next/server";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { deleteSessionAndResources } from "@/lib/reaping/delete-session";
import { archiveSession } from "@/lib/sandbox/archive-session";
import { hasRuntimeSandboxState } from "@/lib/sandbox/utils";
import { BAD_REQUEST, SESSION_NOT_FOUND } from "@/lib/error-copy";

import {
  type UpdateSessionRequest,
  updateSessionRequestSchema,
} from "./update-session-request";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }

  return Response.json({ session: existingSession });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }

  // Parsed against an allow-list, never cast. A cast is erased at runtime, so
  // the body used to be spread straight into `updateSession` — and drizzle
  // writes every key that names a column. `{"userId": "<someone else>"}` gave
  // the session away; `{"sandboxState": …}` repointed it at another user's
  // workspace, which the /files and /diff guards would then serve, because they
  // only ever check that you own your own row.
  const parsedBody = updateSessionRequestSchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsedBody.success) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }
  const body: UpdateSessionRequest = parsedBody.data;

  const shouldStopSandboxAfterArchive =
    body.status === "archived" && existingSession.status !== "archived";

  const shouldUnarchive =
    body.status === "running" && existingSession.status === "archived";

  if (shouldUnarchive && hasRuntimeSandboxState(existingSession.sandboxState)) {
    return Response.json(
      {
        error:
          "This workspace is still going to sleep. Wait a few seconds, then unarchive it again.",
      },
      { status: 409 },
    );
  }

  const updatePayload: UpdateSessionRequest &
    Partial<{
      lifecycleState: "archived" | null;
      lifecycleError: null;
      sandboxExpiresAt: null;
      hibernateAfter: null;
    }> = { ...body };

  if (shouldUnarchive) {
    // Reset lifecycle state so the session can be resumed normally.
    // If there is saved sandbox state, the client will surface Resume again.
    updatePayload.lifecycleState = null;
    updatePayload.lifecycleError = null;
  }

  const updatedSession = shouldStopSandboxAfterArchive
    ? (
        await archiveSession(sessionId, {
          currentSession: existingSession,
          update: updatePayload,
          logPrefix: "[Sessions]",
          scheduleBackgroundWork: after,
        })
      ).session
    : await updateSession(sessionId, updatePayload);

  if (!updatedSession) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }

  return Response.json({ session: updatedSession });
}

/**
 * Delete a session, its container, and its workspace on disk.
 *
 * This used to delete the row and nothing else, which left a running container
 * and a multi-gigabyte worktree that nothing in the product could ever reach
 * again. Deleting a session now means deleting the workspace, because that is
 * what the word means to whoever pressed the button.
 *
 * A workspace holding commits that were never pushed stops the delete with a
 * 409 rather than taking them with it. `?force=1` is the caller saying it has
 * shown the person what they are about to lose and they said yes anyway — the
 * flag exists so the refusal can be recovered from without a second endpoint.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: SESSION_NOT_FOUND }, { status: 404 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  const result = await deleteSessionAndResources(existingSession, { force });

  if (!result.ok) {
    return Response.json(
      {
        error:
          "This workspace has work that isn't saved anywhere else. Push it, or delete it again to confirm you want it gone.",
        unsavedWork: result.blockedBy,
      },
      { status: 409 },
    );
  }

  return Response.json({
    success: true,
    removedContainers: result.removedContainers,
    removedWorkspaces: result.removedWorkspaces.length,
    freedBytes: result.freedBytes,
    warnings: result.warnings,
  });
}
