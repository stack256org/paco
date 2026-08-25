import {
  chatDir,
  connectSandbox,
  repoDir,
  type SandboxState,
} from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { canOperateOnSandbox } from "@/lib/sandbox/utils";

/**
 * Whether a chat's worktree removal actually left anything behind.
 *
 * Deleting a chat used to delete one database row. `removeChatWorktree` has
 * existed in `@paco/sandbox` the whole time and was called from nothing but an
 * integration test, so every deleted chat left its worktree on disk — a
 * directory nothing could reach and nothing would ever reclaim, because the
 * orphan sweep looks for whole workspaces, not worktrees inside one.
 *
 * Pure so the decision can be tested without Docker: `git worktree remove`
 * failing because the worktree is already gone is a success — the desired end
 * state is "not on disk", and a chat whose workspace never started never had
 * one. Any other failure is a real one, and the caller keeps the row so the
 * user can try again rather than being left with an orphan and no handle on it.
 *
 * "not a git repository" is deliberately *not* in that forgiving list, though
 * it looks like it belongs: it means the repository itself is missing, not
 * that this one worktree is. Treating it as success would delete the row on
 * the strength of a broken workspace and strand every worktree in it.
 */

/** The substrings git uses when the path is not a worktree it knows about. */
const ALREADY_ABSENT = [
  "is not a working tree",
  "not a valid path",
  "no such file or directory",
];

export type WorktreeRemovalOutcome =
  | { kind: "removed" }
  | { kind: "already-absent" }
  | { kind: "not-running" }
  | { kind: "failed"; reason: string };

export function classifyWorktreeRemoval(result: {
  success: boolean;
  stderr?: string;
  stdout?: string;
}): WorktreeRemovalOutcome {
  if (result.success) {
    return { kind: "removed" };
  }

  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();

  if (ALREADY_ABSENT.some((phrase) => output.includes(phrase))) {
    return { kind: "already-absent" };
  }

  const reason = (result.stderr ?? result.stdout ?? "").trim();
  return {
    kind: "failed",
    reason: reason || "git did not say why.",
  };
}

/** What the user is told when the files could not be released. */
export const CHAT_DELETE_BLOCKED =
  "We couldn't remove this chat's files, so it hasn't been deleted. Try again in a moment — nothing has been lost.";

/**
 * What the user is told when the workspace is not running.
 *
 * Refusing is the honest answer: the worktree lives inside the workspace, and
 * removing it needs the workspace awake. Deleting the row anyway would leave
 * the files behind with nothing pointing at them.
 */
export const CHAT_DELETE_NEEDS_WORKSPACE =
  "This chat's files live in a workspace that isn't running. Open the workspace first, then delete the chat.";

/** How long a single git worktree command is allowed to run. */
const WORKTREE_REMOVAL_TIMEOUT_MS = 30_000;

/**
 * Removes one chat's worktree on the container side, keeping its branch.
 *
 * Extracted from the chat DELETE route (`app/api/sessions/[sessionId]/chats/[chatId]/route.ts`)
 * so a second caller — `lib/evals/runner.ts`'s throwaway-chat cleanup — gets
 * the exact same "files before row" guarantee instead of a copy that could
 * drift. `@paco/sandbox`'s own `removeChatWorktree` (`docker/worktree.ts`)
 * does the same two git commands but ignores their result entirely; this
 * version exists because both callers need to know *whether* it worked
 * before they decide what to do about the database row.
 *
 * `canOperateOnSandbox` is checked first rather than left to `connectSandbox`
 * to fail on its own: a workspace that was never started or has been
 * archived has no worktree to remove and no container to remove it from, and
 * `{ kind: "not-running" }` lets each caller decide what that means for it
 * (the route refuses the delete; the runner records it as a harness error).
 *
 * The prune that follows a successful (or already-absent) removal is
 * best-effort and its result is not inspected, matching the route's original
 * behaviour: it only drops the administrative entry the removed worktree
 * left behind, and a chat id can still be reused even if pruning itself
 * fails.
 */
export async function removeChatWorktree(
  sandboxState: SandboxState | null | undefined,
  chatId: string,
): Promise<WorktreeRemovalOutcome> {
  if (!canOperateOnSandbox(sandboxState)) {
    return { kind: "not-running" };
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    const workspaceRoot = hostWorkspaceFor(sandboxState);
    const repo = repoDir(workspaceRoot);

    const removal = classifyWorktreeRemoval(
      await sandbox.exec(
        `git worktree remove --force ${JSON.stringify(chatDir(workspaceRoot, chatId))}`,
        repo,
        WORKTREE_REMOVAL_TIMEOUT_MS,
      ),
    );

    if (removal.kind === "failed") {
      return removal;
    }

    await sandbox.exec("git worktree prune", repo, WORKTREE_REMOVAL_TIMEOUT_MS);
    return removal;
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
