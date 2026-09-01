import { requireOwnedSession } from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import { buildLifecycleActivityUpdate } from "@/lib/sandbox/lifecycle";
import { BAD_REQUEST } from "@/lib/error-copy";

interface ActivityRequest {
  sessionId: string;
}

/**
 * Lightweight endpoint to refresh the inactivity timer (`lastActivityAt` and
 * `hibernateAfter`) without touching sandbox expiry.  Called by the client
 * when the user focuses the chat textarea so typing activity prevents
 * premature hibernation.
 */
export async function POST(req: Request) {
  let body: ActivityRequest;
  try {
    body = (await req.json()) as ActivityRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const sessionContext = await requireOwnedSession({
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  // Only refresh activity when the sandbox lifecycle is active.
  if (sessionRecord.lifecycleState !== "active") {
    return Response.json({ success: false, reason: "not-active" });
  }

  await updateSession(sessionId, buildLifecycleActivityUpdate());

  return Response.json({ success: true });
}
