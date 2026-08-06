import { connectSandbox, type SandboxState } from "@paco/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getGitIdentity } from "@/lib/github/gh-identity";
import { updateSession } from "@/lib/db/sessions";
import { parseGitHubHttpsUrl } from "@/lib/github/urls";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  classifySetupFailure,
  isSetupFailureRetryable,
  setupFailureMessage,
} from "@/lib/sandbox/setup-failure-copy";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getSessionSandboxName,
  hasResumableSandboxState,
} from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import {
  BAD_REQUEST,
  GITHUB_NOT_CONNECTED,
  SIGNED_OUT,
} from "@/lib/error-copy";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
}

//   userId: string;
//   sessionRecord: SessionRecord;
//   sandbox: Awaited<ReturnType<typeof connectSandbox>>;
// }): Promise<void> {
//     return;
//   }
//
//   if (!token) {
//     return;
//   }
//
//     token,
//   });
//   if (!dotenvContent) {
//     return;
//   }
//
//   await params.sandbox.writeFile(
//     `${params.sandbox.workingDirectory}/.env.local`,
//     dotenvContent,
//     "utf-8",
//   );
// }

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const { repoUrl, branch = "main", isNewBranch = false, sessionId } = body;

  if (!sessionId) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  // Get session for auth
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: SIGNED_OUT }, { status: 401 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["sandbox-create", session.user.id]),
    limit: 20,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  // Validate session ownership before minting any short-lived setup tokens.
  let sessionRecord: SessionRecord | undefined;
  const sessionContext = await requireOwnedSession({
    userId: session.user.id,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  sessionRecord = sessionContext.sessionRecord;

  const sandboxName = getSessionSandboxName(sessionId);

  const source = repoUrl
    ? {
        repo: repoUrl,
        branch: isNewBranch ? undefined : branch,
        newBranch: isNewBranch ? branch : undefined,
      }
    : undefined;

  // The user's own token is what clones the repository. The App path verified
  // an installation and minted a repo-scoped read token; a personal token has
  // no installation to check, and whether it can read the repository is
  // answered by the clone itself.
  let setupToken: string | undefined;

  if (repoUrl) {
    if (!parseGitHubHttpsUrl(repoUrl)) {
      return Response.json(
        {
          error:
            "That doesn't look like a GitHub repository address. Check it and try again.",
        },
        { status: 400 },
      );
    }

    const token = await getGithubToken(session.user.id);
    if (!token) {
      return Response.json({ error: GITHUB_NOT_CONNECTED }, { status: 400 });
    }
    setupToken = token;
  }

  // ============================================
  // CREATE OR RESUME: Create a named persistent sandbox for this session.
  // ============================================
  const startTime = Date.now();

  let sandbox: Awaited<ReturnType<typeof connectSandbox>>;
  try {
    const identity = await getGitIdentity(session.user.id);
    const gitUser = {
      name: session.user.name?.trim() || identity.name,
      email: identity.email,
    };

    sandbox = await connectSandbox({
      state: {
        type: "docker",
        ...(sandboxName ? { sandboxName } : {}),
        source,
      },
      options: {
        ...(setupToken ? { githubToken: setupToken } : {}),
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        cpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        resume: !!sandboxName,
        createIfMissing: !!sandboxName,
      },
    });
  } catch (error) {
    // Without this, any Docker fault escaped as an unhandled 500 whose body was
    // not JSON, so the client could not parse a message out of it and fell back
    // to "Failed to create sandbox. Please try again." — the same sentence for a
    // missing Docker installation, a stopped daemon, an unbuilt image and a
    // full disk, none of which a retry fixes.
    console.error("[sandbox] create failed:", error);
    const reason = classifySetupFailure(error);

    if (sessionId) {
      await updateSession(sessionId, {
        lifecycleState: "failed",
        lifecycleError: error instanceof Error ? error.message : String(error),
      });
    }

    return Response.json(
      {
        error: setupFailureMessage(reason),
        reason,
        retryable: isSetupFailureRetryable(reason),
      },
      // 503 for "this host cannot run a workspace right now", which is what
      // every one of these is — the request itself was fine.
      { status: 503 },
    );
  } finally {
    // Nothing to revoke: this is the user's own token, not one minted here.
  }

  if (sessionId && sandbox.getState) {
    const nextState = sandbox.getState() as SandboxState;
    await updateSession(sessionId, {
      sandboxState: nextState,
      lifecycleVersion: getNextLifecycleVersion(
        sessionRecord?.lifecycleVersion,
      ),
      ...buildActiveLifecycleUpdate(nextState),
    });

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "sandbox-created",
    });
  }

  const readyMs = Date.now() - startTime;

  return Response.json({
    createdAt: Date.now(),
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: repoUrl ? branch : undefined,
    // The client turns this into the sandbox state's `type`, which the rest of
    // the app matches against "docker".
    mode: "docker",
    timing: { readyMs },
  });
}

export async function DELETE(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["sandbox-delete", authResult.userId]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("sessionId" in body) ||
    typeof (body as Record<string, unknown>).sessionId !== "string"
  ) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const { sessionId } = body as { sessionId: string };

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  // If there's no sandbox to stop, return success (idempotent)
  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  // Connect and stop using unified API
  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  await sandbox.stop();

  const clearedState = clearSandboxState(sessionRecord.sandboxState);
  await updateSession(sessionId, {
    sandboxState: clearedState,
    lifecycleState: hasResumableSandboxState(clearedState)
      ? "hibernated"
      : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
