/**
 * What the commit panel should say, worked out from data rather than decided
 * inline in the middle of a click handler.
 *
 * Two things went wrong when it was decided inline. Saving a commit that could
 * not be pushed was reported as a total failure, because the panel treated any
 * `error` on the result as one — so work that *was* saved showed in red, the
 * diff was never refreshed, and the button stayed live, inviting a second
 * commit of nothing. And a button with nothing to commit was simply disabled,
 * with no sentence anywhere saying why, which is also the state of the panel
 * on first paint before any git status has arrived.
 */

/** The part of `CommitResult` that decides how the panel reads. */
export type CommitAttempt = {
  committed: boolean;
  pushed: boolean;
  error?: string;
};

export type CommitOutcome =
  /** The work is safe, and as far as it can go. */
  | { kind: "saved" }
  /** The commit exists on this computer; GitHub does not have it. */
  | { kind: "saved-not-sent"; reason: string }
  /** Nothing was committed. This is the only real failure. */
  | { kind: "failed"; reason: string };

const COMMIT_FAILED =
  "We couldn't save your changes. Reload the page and try again.";

const PUSH_FAILED =
  "Saved on this computer, but Paco couldn't send it to GitHub. Try again in a moment.";

export function commitOutcome(
  result: CommitAttempt,
  { hasRepo }: { hasRepo: boolean },
): CommitOutcome {
  if (!result.committed) {
    return { kind: "failed", reason: result.error ?? COMMIT_FAILED };
  }

  // A workspace with no GitHub repository has nowhere to push to, so an
  // unpushed commit there is the whole of the job, not half of it.
  if (result.pushed || !hasRepo) {
    return { kind: "saved" };
  }

  return { kind: "saved-not-sent", reason: result.error ?? PUSH_FAILED };
}

/** Why the save button cannot be pressed right now. `null` means it can. */
export type CommitBlocker =
  | "agent-working"
  | "workspace-starting"
  | "checking-changes"
  | "nothing-to-save";

export function commitBlocker(input: {
  isAgentWorking: boolean;
  hasSandbox: boolean;
  /** False until the first git status has come back. */
  gitStatusKnown: boolean;
  hasPendingGitWork: boolean;
}): CommitBlocker | null {
  if (input.isAgentWorking) {
    return "agent-working";
  }
  if (!input.hasSandbox) {
    return "workspace-starting";
  }
  // Checked before "nothing to save", because with no status yet there is no
  // pending work either, and answering "nothing has changed" from missing data
  // is a guess that reads as a verdict.
  if (!input.gitStatusKnown) {
    return "checking-changes";
  }
  if (!input.hasPendingGitWork) {
    return "nothing-to-save";
  }
  return null;
}

/**
 * Each blocker as a cause and, where the user can do something, what.
 *
 * Phrased for someone who has never used git: "commit", "sandbox" and "git
 * status" are Paco's words for these things, not theirs.
 */
export function commitBlockerMessage(blocker: CommitBlocker): string {
  switch (blocker) {
    case "agent-working":
      return "Paco is still working on this chat. Wait for it to finish, then save.";
    case "workspace-starting":
      return "This chat's workspace is still starting up. Saving turns on as soon as it is ready.";
    case "checking-changes":
      return "Checking what has changed…";
    case "nothing-to-save":
      return "There's nothing to save — no files have changed yet. Make a change, or ask Paco to, and this turns on.";
    default:
      return "";
  }
}
