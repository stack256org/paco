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
