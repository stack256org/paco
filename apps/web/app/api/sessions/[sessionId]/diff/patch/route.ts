import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { connectSandbox } from "@paco/sandbox";
import { requireOwnedSessionWithSandboxGuard } from "@/app/api/sessions/_lib/session-context";
import {
  createDownloadDiff,
  DownloadDiffError,
} from "@/lib/diff/download-diff";
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

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "-");
}

export async function GET(request: Request, context: RouteContext) {
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

  try {
    const sandbox = await connectSandbox(sandboxState);
    // Build the file from live git state so committed, staged, unstaged, and
    // readable untracked changes all match the full Changes view.
    const diff = await createDownloadDiff(
      sandbox,
      resolveWorkCwd(
        sandboxState,
        new URL(request.url).searchParams.get("chatId"),
      ),
    );
    const filename = contentDispositionFilename(diff.filename);

    return new Response(diff.content, {
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": "text/x-diff; charset=utf-8",
      },
    });
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

    if (error instanceof DownloadDiffError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Failed to download diff:", error);
    return Response.json({ error: WORKSPACE_UNREACHABLE }, { status: 500 });
  }
}
