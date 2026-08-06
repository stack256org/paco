// No "server-only" marker: this is plain data and pure functions with no
// server dependencies, so the UI and the tests can import it directly.

/**
 * Why a pull request cannot be merged, as a value rather than a sentence.
 *
 * Merge readiness used to hand the UI a `string[]`, and both merge surfaces
 * decided what to offer by matching those strings against a hard-coded list.
 * The two lists had drifted apart completely — not one string was shared — so
 * "Merge anyway" and "Fix conflicts" were unreachable no matter what GitHub
 * said. Nothing failed, because nothing could: user-facing copy was quietly
 * load-bearing, and rewriting a sentence was enough to break a button.
 *
 * The reason is now a field. The message can say anything.
 */
export type MergeBlockerCode =
  | "not-open"
  | "draft"
  | "conflicts"
  | "checks-failing"
  | "checks-running"
  | "no-pull-request"
  | "github-not-connected"
  | "github-unavailable"
  | "workspace-not-running"
  | "no-repository";

export type MergeBlocker = {
  code: MergeBlockerCode;
  /** The plain-language sentence shown to the user. Never matched on. */
  message: string;
};

/**
 * Blockers GitHub itself will let a user merge past.
 *
 * Failing and running checks are advisory: GitHub accepts the merge, and the
 * person deciding may know the failure is unrelated. Everything else is a
 * refusal — a draft, a closed pull request, or a conflict cannot be merged by
 * clicking harder, so offering "Merge anyway" would be a lie.
 */
const FORCE_BYPASSABLE: ReadonlySet<MergeBlockerCode> =
  new Set<MergeBlockerCode>(["checks-failing", "checks-running"]);

export function isForceBypassable(code: MergeBlockerCode): boolean {
  return FORCE_BYPASSABLE.has(code);
}

export function hasBlocker(
  blockers: readonly MergeBlocker[],
  code: MergeBlockerCode,
): boolean {
  return blockers.some((blocker) => blocker.code === code);
}

/** The blockers that no amount of confirming will get past. */
export function nonBypassableBlockers(
  blockers: readonly MergeBlocker[],
): MergeBlocker[] {
  return blockers.filter((blocker) => !isForceBypassable(blocker.code));
}

/** Whether to offer "Merge anyway": blocked, but only by things GitHub allows. */
export function canForceMerge(blockers: readonly MergeBlocker[]): boolean {
  return blockers.length > 0 && nonBypassableBlockers(blockers).length === 0;
}

/** Codes whose sentence never varies. */
type FixedMergeBlockerCode = Exclude<
  MergeBlockerCode,
  "checks-failing" | "checks-running" | "github-unavailable"
>;

/**
 * Cause first, then the next action, in the words of someone who has never
 * used git. "The branch has conflicts with its base" tells a person who
 * already knows what happened that it happened.
 */
const FIXED_MESSAGES: Record<FixedMergeBlockerCode, string> = {
  "not-open": "This pull request has already been closed or merged on GitHub.",
  draft:
    "This pull request is still marked as a draft on GitHub. Mark it ready for review there, then try again.",
  conflicts:
    "Your changes and the branch you're merging into both edited the same lines, so they can't be combined automatically. Use Fix conflicts to have the assistant sort it out.",
  "no-pull-request":
    "This chat doesn't have an open pull request on GitHub yet. Create one first, then come back here to merge it.",
  "github-not-connected":
    "Paco isn't connected to your GitHub account yet. Connect GitHub in Settings, then try again.",
  "workspace-not-running":
    "This workspace isn't running, so we can't ask GitHub about the pull request. Start the workspace, then try again.",
  "no-repository":
    "This workspace isn't linked to a GitHub repository, so there's nothing to merge.",
};

export function mergeBlocker(code: FixedMergeBlockerCode): MergeBlocker {
  return { code, message: FIXED_MESSAGES[code] };
}

export function checksFailingBlocker(count: number): MergeBlocker {
  const subject =
    count === 1 ? "1 automated check" : `${count} automated checks`;

  return {
    code: "checks-failing",
    message: `${subject} on GitHub didn't pass. Use Fix errors to have the assistant look at them, or merge anyway if you know they're unrelated.`,
  };
}

export function checksRunningBlocker(count: number): MergeBlocker {
  const subject =
    count === 1 ? "1 automated check" : `${count} automated checks`;
  const verb = count === 1 ? "is" : "are";

  return {
    code: "checks-running",
    message: `${subject} on GitHub ${verb} still running. They usually finish in a few minutes.`,
  };
}

/**
 * GitHub answered with a failure rather than an answer.
 *
 * The message comes from `gh-failure-copy`, which already turns a missing CLI,
 * a revoked token, or an unreachable network into something to act on. Passing
 * it through is what keeps those causes from being flattened into "this chat
 * has no pull request", which is what the old bare `catch` claimed.
 */
export function githubUnavailableBlocker(message: string): MergeBlocker {
  return { code: "github-unavailable", message };
}
