import { connectSandbox, type SandboxState } from "@paco/sandbox";
import { requireOwnedSessionWithSandboxGuard } from "@/app/api/sessions/_lib/session-context";
import { updateSession } from "@/lib/db/sessions";
import { EXTEND_TIMEOUT_DURATION_MS } from "@/lib/sandbox/config";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { BAD_REQUEST, WORKSPACE_NOT_STARTED } from "@/lib/error-copy";

interface ExtendRequest {
  sessionId: string;
}

export async function POST(req: Request) {
  const limited = await checkRateLimit({
    key: rateLimitKey(["sandbox-extend"]),
    limit: 3,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let body: ExtendRequest;
  try {
    body = (await req.json()) as ExtendRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const { sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    sessionId,
    sandboxGuard: isSandboxActive,
    sandboxErrorMessage: WORKSPACE_NOT_STARTED,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;
  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    return Response.json({ error: WORKSPACE_NOT_STARTED }, { status: 400 });
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    if (!sandbox.extendTimeout) {
      return Response.json(
        {
          error:
            "This workspace stays awake on its own — there is nothing to extend.",
        },
        { status: 400 },
      );
    }
    const result = await sandbox.extendTimeout(EXTEND_TIMEOUT_DURATION_MS);

    // Persist updated expiresAt to database
    if (typeof sandbox.getState === "function") {
      const newState = sandbox.getState();
      if (newState) {
        await updateSession(sessionId, {
          sandboxState: newState as SandboxState,
          lifecycleVersion: getNextLifecycleVersion(
            sessionRecord.lifecycleVersion,
          ),
          ...buildActiveLifecycleUpdate(newState as SandboxState),
        });
      }
    }

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "timeout-extended",
    });

    return Response.json({
      success: true,
      expiresAt: result.expiresAt,
      extendedBy: EXTEND_TIMEOUT_DURATION_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to extend sandbox timeout:", message);
    return Response.json(
      {
        error:
          "We couldn't keep this workspace awake for longer. Try again in a moment.",
      },
      { status: 500 },
    );
  }
}
