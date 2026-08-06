import * as path from "node:path";
import {
  chatWorktreePath,
  repoDir,
  type SandboxState,
  workspaceRoot,
} from "@paco/sandbox";

/**
 * Where a session's workspace lives on the host.
 *
 * `hostWorkspace` is absent from state persisted since the path stopped being
 * published to the browser, so it is normally derived from the sandbox name.
 * Older rows that still carry it keep working.
 */
export function hostWorkspaceFor(state: SandboxState): string {
  if ("hostWorkspace" in state && typeof state.hostWorkspace === "string") {
    return state.hostWorkspace;
  }
  if (state.sandboxName) {
    return path.join(workspaceRoot(), state.sandboxName);
  }
  throw new Error(
    "Sandbox state has neither hostWorkspace nor sandboxName; cannot locate the workspace",
  );
}

/**
 * Where a chat's worktree lives on the host.
 *
 * This is the directory Claude Code runs in. It matters that it is the chat's
 * worktree and not the session's repository: the agent runs on the host, so
 * whatever directory it starts in is the one whose branch its edits land on.
 */
export function hostChatWorktree(state: SandboxState, chatId: string): string {
  return path.join(hostWorkspaceFor(state), chatWorktreePath(chatId));
}

/**
 * The directory an operation should run in.
 *
 * With a chat, its worktree — that is where the branch and the work are. A
 * session-wide caller gets the repository instead.
 *
 * Almost everything in Paco is chat-scoped now, and getting this wrong is not
 * loud: the session repository is a real git repository sitting on the default
 * branch, so a diff, a file listing, or a `git status` against it succeeds and
 * simply shows nothing. That silence is why this is one function rather than a
 * `?? sandbox.workingDirectory` repeated at each call site.
 */
export function resolveWorkCwd(
  state: SandboxState,
  chatId?: string | null,
): string {
  return chatId
    ? hostChatWorktree(state, chatId)
    : repoDir(hostWorkspaceFor(state));
}
