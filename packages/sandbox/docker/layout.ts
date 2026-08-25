import * as path from "node:path";

/**
 * Where things live inside a session's workspace.
 *
 * A session is one git repository; a chat is one worktree of it. Both live
 * under the session's directory, which is what makes worktrees possible at
 * all: a worktree is not self-contained — its `.git` is a *file* pointing back
 * into `repo/.git/worktrees/<name>` — so the repository and every worktree of
 * it must sit under the same mount or git cannot resolve them.
 *
 *   <workspace>/            <- mounted at BOTH /workspace and its host path
 *     repo/                 <- the clone, on its default branch
 *     chats/<chatId>/       <- a worktree, on branch chat/<chatId>
 *
 * These helpers take the workspace root and return absolute paths, rather than
 * hard-coding `/workspace`. Git records the absolute location of a worktree in
 * two pointer files, and those files have to name a path that is true on the
 * host — where Claude Code runs — as well as inside the container. Relative
 * pointers would sidestep that, but git only learned to write them in 2.48:
 * on the 2.39 in the sandbox image, `git worktree list` reports a
 * relative-pointer worktree as *prunable* and the next `git worktree prune`
 * silently deletes the link. Hence the double mount and one absolute path.
 */

/** Directory holding the repository itself, relative to the workspace root. */
export const REPO_DIRNAME = "repo";

/** Directory holding one worktree per chat, relative to the workspace root. */
export const CHATS_DIRNAME = "chats";

/**
 * Reject anything that could escape the workspace when used as a path segment.
 *
 * Chat ids are generated, so this should never fire — which is exactly why it
 * throws rather than sanitising: a chat id that needs cleaning up means an id
 * arrived from somewhere it should not have.
 */
export function assertPathSegment(pathSegment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(pathSegment)) {
    throw new Error(`Unsafe chat id for a path segment: ${pathSegment}`);
  }
  return pathSegment;
}

/** The repository, as an absolute path under a workspace root. */
export function repoDir(workspaceRoot: string): string {
  return path.posix.join(workspaceRoot, REPO_DIRNAME);
}

/** A chat's worktree, relative to the workspace root. */
export function chatWorktreePath(chatId: string): string {
  return `${CHATS_DIRNAME}/${assertPathSegment(chatId)}`;
}

/** A chat's worktree, as an absolute path under a workspace root. */
export function chatDir(workspaceRoot: string, chatId: string): string {
  return path.posix.join(workspaceRoot, chatWorktreePath(chatId));
}

/**
 * The branch a chat works on.
 *
 * Namespaced under `chat/` so it never collides with a branch that came from
 * the repository, and so `git branch --list 'chat/*'` enumerates exactly the
 * branches Paco created.
 */
export function chatBranchName(chatId: string): string {
  return `chat/${assertPathSegment(chatId)}`;
}
