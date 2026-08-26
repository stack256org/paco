import {
  type ChatWorktree,
  connectSandbox,
  discoverSkills,
  ensureChatWorktree,
  type Sandbox,
  type SandboxState,
} from "@paco/sandbox";
import { buildChatEnvironmentDetails } from "@/lib/agent/chat-environment";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { getSessionById } from "@/lib/db/sessions";
import {
  readSandboxSetupOutlook,
  type SandboxSetupOutlook,
} from "@/lib/sandbox/lifecycle";
import { ProvisioningError } from "@/lib/sandbox/provisioning-errors";
import {
  kickSandboxProvisioningWorkflow,
  waitForSandboxProvisioningRun,
} from "@/lib/sandbox/provisioning-kick";
import { classifySetupFailureText } from "@/lib/sandbox/setup-failure-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;

export type ResolvedChatSandboxRuntime = {
  sandboxState: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  /** The chat's own worktree, and the branch its changes land on. */
  worktree: ChatWorktree;
  /**
   * The worktree's path on the host — where the agent process is started.
   *
   * Resolved here rather than by the caller because computing it needs
   * `node:path` and the sandbox package, and the workflow function this feeds
   * cannot import Node modules at all. Steps run in Node; the workflow does
   * not.
   */
  hostWorkingDirectory: string;
  skills: DiscoveredSkills;
  didSetupWorkspace: boolean;
  sessionTitle: string;
  repoOwner?: string;
  repoName?: string;
  /** The repository's default branch — what a pull request targets. */
  baseBranch: string;
};

async function loadSessionSkills(params: {
  sessionId: string;
  sandboxState: SandboxState;
  sandbox: Sandbox;
}): Promise<DiscoveredSkills> {
  const cachedSkills = await getCachedSkills(
    params.sessionId,
    params.sandboxState,
  );
  if (cachedSkills !== null) {
    return cachedSkills;
  }

  const skillDirs = await getSandboxSkillDirectories(params.sandbox);
  const discoveredSkills = await discoverSkills(params.sandbox, skillDirs);
  await setCachedSkills(
    params.sessionId,
    params.sandboxState,
    discoveredSkills,
  );
  return discoveredSkills;
}

/**
 * How many times a turn will follow provisioning to a different run before it
 * gives up and says it stopped waiting.
 *
 * A hand-off is not a retry and does not cost a provisioning attempt: each pass
 * attaches to whichever run already owns the session and waits for it, so the
 * bound is on how many times ownership may change under us, not on how long we
 * wait. Three is generous — ownership changes when two turns race to start the
 * same session, and a third change means something is wrong that waiting longer
 * will not fix.
 */
const MAX_PROVISIONING_HANDOFFS = 3;

/** The archived answer as a reason, so the user is told which it was. */
function archivedError(): ProvisioningError {
  // A reason, not a sentence. This used to be a plain Error whose message
  // the caller matched on, so the archived case reached the user as the
  // generic "Workspace setup failed" — see provisioning-errors.ts.
  return new ProvisioningError("archived", "Session is archived");
}

/**
 * What to throw when we ran out of patience or out of explanations.
 *
 * Neither branch invents a fallback sentence for the classifier to fail to
 * match. `"Workspace setup failed"` used to be that sentence, and because no
 * matcher recognises it, every caller that reached it was told the vaguest
 * thing Paco can say about a session that had usually not failed at all.
 * `ProvisioningError` stamps the reason into the message instead, so the
 * decision survives the workflow boundary as a fact rather than as prose to be
 * re-guessed on the far side.
 */
function unfinishedSetupError(
  outlook: SandboxSetupOutlook,
  sessionId: string,
): ProvisioningError {
  if (outlook.status === "in-progress") {
    // True, and the only honest thing to say: setup is still running, we
    // stopped waiting for it. `timed-out` is also the one reason whose copy
    // already tells the reader that a retry picks up where this left off,
    // which is exactly what a half-finished provision does.
    return new ProvisioningError(
      "timed-out",
      `Workspace setup for session ${sessionId} was still running after ${MAX_PROVISIONING_HANDOFFS} hand-offs.`,
    );
  }

  return new ProvisioningError(
    "unknown",
    `Workspace setup for session ${sessionId} ended with no sandbox and recorded no cause.`,
  );
}

/**
 * Get a session to an active sandbox, or explain truthfully why not.
 *
 * The loop exists because "provisioning is in flight" and "provisioning failed
 * for a reason nobody wrote down" used to be the same observation: an empty
 * `lifecycleError`. A turn that read the session during another run's window
 * therefore reported a setup failure, in the generic words, for a session that
 * was mid-provision and about to succeed. Rather than invent a sentence about
 * waiting, this waits — it attaches to whichever run actually owns the session
 * and follows it, which is what the turn should have been doing all along.
 *
 * A recorded failure short-circuits the loop before any re-kick. Re-kicking a
 * session that just failed would start a fresh run and bury the cause behind a
 * second attempt, which is the opposite of the fix.
 */
async function getReadySessionSandbox(params: {
  sessionId: string;
  userId: string;
}): Promise<{ session: SessionRecord; didSetupWorkspace: boolean }> {
  let session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived") {
    throw archivedError();
  }
  if (isSandboxActive(session.sandboxState)) {
    return { session, didSetupWorkspace: false };
  }

  let outlook: SandboxSetupOutlook = { status: "in-progress" };

  for (let handoff = 0; handoff < MAX_PROVISIONING_HANDOFFS; handoff++) {
    const kick = await kickSandboxProvisioningWorkflow(params.sessionId);
    if (kick.status === "skipped") {
      if (kick.skipReason === "session-not-found") {
        throw new Error("Session not found");
      }
      if (kick.skipReason === "session-archived") {
        throw archivedError();
      }
      // "superseded": this turn lost the race to start provisioning. That says
      // nothing about whether the workspace can be set up, so it is not a
      // failure and must not be reported as one.
    }

    const waitedRunId = kick.runId ?? null;
    // Rejects if that run failed, and that rejection is the good path: it
    // carries the reason tag out through the workflow boundary.
    const outcome = waitedRunId
      ? await waitForSandboxProvisioningRun(waitedRunId)
      : null;

    session = await getSessionById(params.sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    if (session.status === "archived") {
      throw archivedError();
    }
    if (isSandboxActive(session.sandboxState)) {
      return { session, didSetupWorkspace: true };
    }

    outlook = readSandboxSetupOutlook({ session, waitedRunId });
    if (outlook.status === "failed") {
      // `lifecycleError` is whatever Docker or git said, flattened to a string
      // by the provisioning workflow — a different run, so the original error
      // object is long gone. Reading a reason back out of that text here is
      // what lets the user be told that Docker is not running rather than "try
      // again". `readSandboxSetupOutlook` has already established that the text
      // describes the attempt this turn was waiting on.
      throw new ProvisioningError(
        classifySetupFailureText(outlook.error),
        outlook.error,
      );
    }

    const superseded =
      kick.status === "skipped" || outcome?.status === "superseded";
    if (outlook.status === "in-progress" || superseded) {
      continue;
    }

    break;
  }

  throw unfinishedSetupError(outlook, params.sessionId);
}

export async function resolveChatSandboxRuntime(params: {
  userId: string;
  sessionId: string;
  chatId: string;
}): Promise<ResolvedChatSandboxRuntime> {
  "use step";

  const { session, didSetupWorkspace } = await getReadySessionSandbox({
    sessionId: params.sessionId,
    userId: params.userId,
  });
  const sandboxState = session.sandboxState;
  if (!sandboxState) {
    // Unreachable while `isSandboxActive` implies a state, but it is still a
    // setup failure and still has to arrive as one: a bare Error here would be
    // classified from prose that matches nothing, which is how the generic
    // copy used to escape.
    throw new ProvisioningError(
      "unknown",
      `Session ${params.sessionId} reported an active sandbox with no state.`,
    );
  }
  const sandbox = await connectSandbox(sandboxState);

  // Idempotent, and it runs on every turn: an existing worktree is returned
  // untouched, so this is cheap after the first turn of a chat.
  const workspaceRoot = hostWorkspaceFor(sandboxState);
  const worktree = await ensureChatWorktree(
    sandbox,
    workspaceRoot,
    params.chatId,
  );

  const skills = await loadSessionSkills({
    sessionId: params.sessionId,
    sandboxState,
    sandbox,
  });

  return {
    sandboxState,
    worktree,
    hostWorkingDirectory: worktree.path,
    workingDirectory: worktree.path,
    currentBranch: worktree.branch,
    environmentDetails: buildChatEnvironmentDetails({
      sandboxDetails: sandbox.environmentDetails,
      worktreePath: worktree.path,
      branch: worktree.branch,
    }),
    skills,
    didSetupWorkspace,
    sessionTitle: session.title,
    repoOwner: session.repoOwner ?? undefined,
    repoName: session.repoName ?? undefined,
    baseBranch: session.branch ?? "main",
  };
}
