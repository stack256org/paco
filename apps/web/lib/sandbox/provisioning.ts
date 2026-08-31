import { ProvisioningError } from "@/lib/sandbox/provisioning-errors";
import "server-only";

import { connectSandbox, type Sandbox, type SandboxState } from "@paco/sandbox";
import {
  getSessionById,
  updateSessionIfNotArchived,
  type SessionRecord,
} from "@/lib/db/sessions";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getGitIdentity } from "@/lib/github/gh-identity";
import { syncPreviewRoutes } from "@/lib/preview/nginx-reload";
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
  getResumableSandboxName,
  getSessionSandboxName,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import { SESSION_NOT_FOUND } from "@/lib/error-copy";

export type ProvisionSessionSandboxResult = {
  sandboxState: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  didSetupWorkspace: boolean;
  session: SessionRecord;
};

export class SessionArchivedDuringProvisioningError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was archived during sandbox provisioning`);
    this.name = "SessionArchivedDuringProvisioningError";
  }
}

function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "docker"
  );
}

function buildSandboxSource(session: SessionRecord): SandboxState["source"] {
  if (!session.cloneUrl) {
    return undefined;
  }

  const branchExistsOnOrigin = session.prNumber != null;
  const shouldCreateNewBranch = session.isNewBranch && !branchExistsOnOrigin;

  return {
    repo: session.cloneUrl,
    ...(shouldCreateNewBranch
      ? { newBranch: session.branch ?? undefined }
      : { branch: session.branch ?? "main" }),
  };
}

function buildSandboxState(session: SessionRecord): SandboxState {
  const existingState = session.sandboxState;
  const sandboxName =
    getResumableSandboxName(existingState) ?? getSessionSandboxName(session.id);
  const source = buildSandboxSource(session);

  return {
    type: "docker",
    ...(isSandboxState(existingState) ? existingState : {}),
    sandboxName,
    ...(source ? { source } : {}),
  };
}

/**
 * The token used to clone a session's repository.
 *
 * The GitHub App path minted a short-lived installation token scoped to one
 * repository, then revoked it. There is no equivalent for a personal token, and
 * inventing one would mean asking GitHub to create and delete a credential on
 * every sandbox start. The user's own token is used directly instead — the same
 * one `gh` uses everywhere else — and it is passed to the clone and cleared
 * immediately afterwards by the sandbox, which already takes care never to
 * persist it in `.git/config`.
 *
 * Returns `undefined` for a session with nothing to clone, which is the normal
 * case for a workspace that started empty.
 */
async function getSetupToken(params: {
  session: SessionRecord;
}): Promise<{ token: string } | undefined> {
  if (!params.session.cloneUrl) {
    return undefined;
  }
  if (!params.session.repoOwner || !params.session.repoName) {
    throw new Error("This session isn't connected to a repository.");
  }

  const token = await getGithubToken();
  if (!token) {
    throw new ProvisioningError(
      "github-not-connected",
      "Connect GitHub in Settings before starting a session from a repository.",
    );
  }

  return { token };
}

async function stopSandboxAfterArchiveRace(params: {
  sessionId: string;
  sandbox: Sandbox;
}): Promise<never> {
  try {
    await params.sandbox.stop();
  } catch (error) {
    console.error(
      `Failed to stop sandbox after session ${params.sessionId} was archived during provisioning:`,
      error,
    );
  }

  throw new SessionArchivedDuringProvisioningError(params.sessionId);
}

export async function provisionSessionSandbox(params: {
  sessionId: string;
}): Promise<ProvisionSessionSandboxResult> {
  const session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (session.status === "archived") {
    throw new ProvisioningError(
      "archived",
      "This session is archived, so it has no workspace to start.",
    );
  }

  const didSetupWorkspace = !isSandboxActive(session.sandboxState);
  const gitUser = await getGitIdentity();
  const setupToken = await getSetupToken({ session });

  let sandbox: Sandbox;
  try {
    sandbox = await connectSandbox({
      state: buildSandboxState(session),
      options: {
        githubToken: setupToken?.token,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        cpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        resume: true,
        createIfMissing: true,
      },
    });
  } finally {
    // Nothing to revoke: this is the user's own long-lived token, not one
    // minted for this clone.
  }

  const rawSandboxState = sandbox.getState?.();
  const sandboxState = isSandboxState(rawSandboxState)
    ? rawSandboxState
    : buildSandboxState(session);

  const updatedSession = await updateSessionIfNotArchived(params.sessionId, {
    sandboxState,
    lifecycleVersion: getNextLifecycleVersion(session.lifecycleVersion),
    lifecycleError: null,
    ...buildActiveLifecycleUpdate(sandboxState),
  });

  if (!updatedSession) {
    await stopSandboxAfterArchiveRace({
      sessionId: params.sessionId,
      sandbox,
    });
  }

  kickSandboxLifecycleWorkflow({
    sessionId: params.sessionId,
    reason: "sandbox-created",
  });

  // Best-effort, fire-and-forget: this session's dev server just published a
  // new (or unchanged) host port, so nginx's preview routing needs
  // reconciling against it. Never on the critical path — a host with no
  // nginx (local dev, CI, a Docker Compose deployment mid-migration) or a
  // transient `sudo`/`nginx -t` hiccup must not stop a sandbox from coming
  // up.
  //
  // This used to claim "the periodic lifecycle sweep will pick this up",
  // and no such sweep existed anywhere — so this call was the ONLY thing in
  // production that ever ran `syncPreviewRoutes`, and `provisioning-kick.ts`
  // skips this function entirely when the sandbox is already up. The sweep
  // now exists for real: `startPreviewReconciliation`
  // (`lib/preview/reconcile-job.ts`), started from `instrumentation.ts`,
  // re-runs this same derivation every minute, so a failure here really is
  // picked up later.
  void syncPreviewRoutes().catch((error) => {
    console.error(
      `Failed to sync preview nginx routes after provisioning session ${params.sessionId}:`,
      error,
    );
  });

  return {
    sandboxState,
    workingDirectory: sandbox.workingDirectory,
    currentBranch: sandbox.currentBranch,
    environmentDetails: sandbox.environmentDetails,
    didSetupWorkspace,
    session: updatedSession ?? session,
  };
}
