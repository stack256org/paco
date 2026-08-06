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
    // A reason, not a sentence. This used to be a plain Error whose message
    // the caller matched on, so the archived case reached the user as the
    // generic "Workspace setup failed" — see provisioning-errors.ts.
    throw new ProvisioningError("archived", "Session is archived");
  }
  if (isSandboxActive(session.sandboxState)) {
    return { session, didSetupWorkspace: false };
  }

  const kick = await kickSandboxProvisioningWorkflow(params.sessionId);
  if (kick.runId) {
    await waitForSandboxProvisioningRun(kick.runId);
  }

  session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!isSandboxActive(session.sandboxState)) {
    // `lifecycleError` is whatever Docker or git said, flattened to a string by
    // the provisioning workflow — a different run, so the original error object
    // is long gone. Reading a reason back out of that text here is what lets
    // the user be told that Docker is not running rather than "try again".
    const raw = session.lifecycleError ?? "Workspace setup failed";
    throw new ProvisioningError(classifySetupFailureText(raw), raw);
  }

  return { session, didSetupWorkspace: true };
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
    throw new Error("Workspace setup failed");
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
