"use server";

import { connectSandbox } from "@paco/sandbox";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  generateBranchName,
  isSafeBranchName,
  looksLikeCommitHash,
} from "@/lib/git/helpers";
import {
  NOT_YOURS,
  SESSION_NOT_FOUND,
  SIGNED_OUT,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";

/**
 * Create a feature branch in the session sandbox.
 */
export async function createBranch(params: {
  /** Create the branch in this chat\'s worktree. */
  chatId?: string;
  sessionId: string;
  sessionTitle: string;
  baseBranch: string;
  branchName: string;
}): Promise<{ branchName: string }> {
  const { sessionId, baseBranch, branchName } = params;

  const session = await getServerSession();
  if (!session?.user) {
    throw new Error(SIGNED_OUT);
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (sessionRecord.userId !== session.user.id) {
    throw new Error(NOT_YOURS);
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }
  if (!baseBranch || !isSafeBranchName(baseBranch)) {
    throw new Error("That branch name can't be used. Pick a different one.");
  }
  if (!branchName || (branchName !== "HEAD" && !isSafeBranchName(branchName))) {
    throw new Error("That branch name can't be used. Pick a different one.");
  }

  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  const cwd = resolveWorkCwd(sessionRecord.sandboxState, params.chatId);

  // resolve live branch
  let resolvedBranch = branchName === "HEAD" ? baseBranch : branchName;
  const branchResult = await sandbox.exec(
    "git symbolic-ref --short HEAD",
    cwd,
    10000,
  );
  const liveBranch = branchResult.stdout.trim();
  if (branchResult.success && liveBranch && liveBranch !== "HEAD") {
    resolvedBranch = liveBranch;
  }

  // fetch from origin
  await sandbox.exec(
    `git fetch origin ${baseBranch}:refs/remotes/origin/${baseBranch}`,
    cwd,
    30000,
  );

  // create branch if on base or detached
  const isDetachedOrOnBase =
    resolvedBranch === baseBranch || looksLikeCommitHash(resolvedBranch);

  if (isDetachedOrOnBase) {
    const generatedBranch = generateBranchName(
      session.user.username,
      session.user.name,
    );
    if (!isSafeBranchName(generatedBranch)) {
      throw new Error(
        "We couldn't build a branch name from your account name. Name the branch yourself.",
      );
    }
    const checkoutResult = await sandbox.exec(
      `git checkout -b ${generatedBranch}`,
      cwd,
      10000,
    );
    if (!checkoutResult.success) {
      console.error(
        "[branch] checkout -b failed:",
        checkoutResult.stderr || checkoutResult.stdout,
      );
      throw new Error(
        "We couldn't create that branch. Reload the page and try again.",
      );
    }
    resolvedBranch = generatedBranch;
  }

  if (!isSafeBranchName(resolvedBranch)) {
    throw new Error("That branch name can't be used. Pick a different one.");
  }

  if (resolvedBranch !== branchName) {
    await updateSession(sessionId, { branch: resolvedBranch }).catch(
      (error) => {
        console.error("Failed to update session branch:", error);
      },
    );
  }

  return { branchName: resolvedBranch };
}
