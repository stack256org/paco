import type { NextRequest } from "next/server";
import { connectSandbox } from "@paco/sandbox";
import { requireOwnedSessionWithSandboxGuard } from "@/app/api/sessions/_lib/session-context";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import {
  computeAndCacheDiff,
  DiffComputationError,
} from "@/lib/diff/compute-diff";
import { updateSession } from "@/lib/db/sessions";
import { buildHibernatedLifecycleUpdate } from "@/lib/sandbox/lifecycle";
import {
  clearUnavailableSandboxState,
  hasRuntimeSandboxState,
  isSandboxUnavailableError,
} from "@/lib/sandbox/utils";
import {
  WORKSPACE_ASLEEP,
  WORKSPACE_NOT_STARTED,
  WORKSPACE_UNREACHABLE,
} from "@/lib/error-copy";

export type { DiffFile, DiffResponse } from "@/lib/diff/compute-diff";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(_req: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;

  const sessionContext = await requireOwnedSessionWithSandboxGuard({
    sessionId,
    sandboxGuard: hasRuntimeSandboxState,
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

  // Each chat works in its own git worktree on its own branch, so a diff is
  // only meaningful once you know which chat is asking. Without the parameter
  // this falls back to the session's repository, which is what callers that
  // are not inside a chat want.
  const chatId = _req.nextUrl.searchParams.get("chatId");

  try {
    const sandbox = await connectSandbox(sandboxState);
    const response = await computeAndCacheDiff({
      sandbox,
      sessionId,
      ...(chatId ? { cwd: hostChatWorktree(sandboxState, chatId) } : {}),
    });
    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isSandboxUnavailableError(message)) {
      await updateSession(sessionId, {
        sandboxState: clearUnavailableSandboxState(
          sessionRecord.sandboxState,
          message,
        ),
        ...buildHibernatedLifecycleUpdate(),
      });
      return Response.json({ error: WORKSPACE_ASLEEP }, { status: 409 });
    }

    if (error instanceof DiffComputationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to get diff:", error);
    return Response.json({ error: WORKSPACE_UNREACHABLE }, { status: 500 });
  }
}
