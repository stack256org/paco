import "server-only";

import { connectSandbox } from "@paco/sandbox";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { chatBranchName } from "@paco/sandbox";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getLatestChatIdForSession } from "@/lib/db/sessions";
import { findPullRequest } from "@/lib/github/gh-pr";
import { canOperateOnSandbox, clearSandboxState } from "./utils";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type SessionUpdateInput = Parameters<typeof updateSession>[1];

interface ArchiveSessionOptions {
  currentSession?: SessionRecord;
  update?: SessionUpdateInput;
  logPrefix?: string;
  scheduleBackgroundWork?: (callback: () => Promise<void>) => void;
}

interface ArchiveSessionResult {
  session: Awaited<ReturnType<typeof updateSession>> | null;
  archiveTriggered: boolean;
}

async function refreshArchiveGitState(
  currentSession: SessionRecord,
  logPrefix: string,
): Promise<SessionUpdateInput> {
  if (!canOperateOnSandbox(currentSession.sandboxState)) {
    return {};
  }

  if (!currentSession.repoOwner || !currentSession.repoName) {
    return {};
  }

  try {
    /*
     * The chat's worktree, not `sandbox.workingDirectory`.
     *
     * This is the `resolveWorkCwd` trap CLAUDE.md warns about, and it had
     * caught this function. `workingDirectory` is the session repository,
     * which sits on the default branch — so `symbolic-ref HEAD` there returned
     * "main", and archiving wrote that over `session.branch`, discarding the
     * chat branch the work is actually on. It succeeded every time, which is
     * why nothing caught it: the repository is a real repository and the
     * command is a real answer, just to a different question.
     *
     * The pull-request lookup below already read from the worktree. Now both
     * halves agree about which directory they are describing.
     */
    const chatId = await getLatestChatIdForSession(currentSession.id);
    if (!chatId || !currentSession.sandboxState) {
      return {};
    }

    const cwd = hostChatWorktree(currentSession.sandboxState, chatId);

    const sandbox = await connectSandbox(currentSession.sandboxState);
    const branchResult = await sandbox.exec(
      "git symbolic-ref --short HEAD",
      cwd,
      10000,
    );

    const branch = branchResult.success ? branchResult.stdout.trim() : "";
    if (!branch) {
      return {};
    }

    const updates: SessionUpdateInput = {};
    const branchChanged = branch !== currentSession.branch;

    if (branchChanged) {
      updates.branch = branch;
    }

    const token = await getGithubToken(currentSession.userId);
    if (!token) {
      return updates;
    }

    const pullRequest = await findPullRequest({
      token,
      cwd,
      branch: chatBranchName(chatId),
    }).catch(() => null);

    if (pullRequest) {
      if (pullRequest.number !== currentSession.prNumber) {
        updates.prNumber = pullRequest.number;
      }
      if (pullRequest.state !== currentSession.prStatus) {
        updates.prStatus = pullRequest.state;
      }
      return updates;
    }

    if (
      currentSession.prNumber !== null ||
      currentSession.prStatus !== null ||
      updates.prNumber !== undefined ||
      updates.prStatus !== undefined
    ) {
      updates.prNumber = null;
      updates.prStatus = null;
    }

    return updates;
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to refresh git/PR state before archiving session ${currentSession.id}:`,
      error,
    );
    return {};
  }
}

async function finalizeArchivedSessionSandbox(
  sessionId: string,
  logPrefix: string,
): Promise<void> {
  try {
    const archivedSession = await getSessionById(sessionId);
    if (!archivedSession || archivedSession.status !== "archived") {
      return;
    }
    if (!canOperateOnSandbox(archivedSession.sandboxState)) {
      return;
    }

    const sandbox = await connectSandbox(archivedSession.sandboxState);
    await sandbox.stop();

    await updateSession(sessionId, {
      sandboxState: clearSandboxState(archivedSession.sandboxState),
      lifecycleState: "archived",
      sandboxExpiresAt: null,
      hibernateAfter: null,
      lifecycleError: null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `${logPrefix} Failed to stop sandbox for archived session ${sessionId}:`,
      error,
    );

    try {
      const sessionAfterFailure = await getSessionById(sessionId);
      if (!sessionAfterFailure || sessionAfterFailure.status !== "archived") {
        return;
      }

      const failurePatch: SessionUpdateInput = {
        lifecycleState: "archived",
        sandboxExpiresAt: null,
        hibernateAfter: null,
        lifecycleError: `Archive finalization failed: ${errorMessage}`,
      };

      if (canOperateOnSandbox(sessionAfterFailure.sandboxState)) {
        failurePatch.sandboxState = clearSandboxState(
          sessionAfterFailure.sandboxState,
        );
      }

      await updateSession(sessionId, failurePatch);
    } catch (persistError) {
      console.error(
        `${logPrefix} Failed to persist archive recovery state for session ${sessionId}:`,
        persistError,
      );
    }
  }
}

export async function archiveSession(
  sessionId: string,
  options: ArchiveSessionOptions = {},
): Promise<ArchiveSessionResult> {
  const currentSession =
    options.currentSession ?? (await getSessionById(sessionId));

  if (!currentSession) {
    return { session: null, archiveTriggered: false };
  }

  const shouldStopSandboxAfterArchive = currentSession.status !== "archived";
  const logPrefix = options.logPrefix ?? "[Sessions]";
  const gitStateUpdate = shouldStopSandboxAfterArchive
    ? await refreshArchiveGitState(currentSession, logPrefix)
    : {};

  const updatePayload: SessionUpdateInput = {
    ...gitStateUpdate,
    ...options.update,
  };

  if (shouldStopSandboxAfterArchive) {
    updatePayload.status = "archived";
    updatePayload.lifecycleState = "archived";
    updatePayload.sandboxExpiresAt = null;
    updatePayload.hibernateAfter = null;
  }

  const updatedSession =
    Object.keys(updatePayload).length > 0
      ? ((await updateSession(sessionId, updatePayload)) ?? null)
      : currentSession;

  const archiveTriggered = shouldStopSandboxAfterArchive && !!updatedSession;

  if (archiveTriggered) {
    const runFinalize = () =>
      finalizeArchivedSessionSandbox(sessionId, logPrefix);

    if (options.scheduleBackgroundWork) {
      options.scheduleBackgroundWork(runFinalize);
    } else {
      void runFinalize();
    }
  }

  return {
    session: updatedSession,
    archiveTriggered,
  };
}
