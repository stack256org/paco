import {
  hasBlocker,
  type MergeBlocker,
  type MergeBlockerCode,
} from "@/lib/github/merge-blockers";

/**
 * Blockers worth asking GitHub about again, on a budget.
 *
 * "Transient" means the answer is expected to change on its own without the
 * user doing anything. A failed call is the case: a rate limit or a network
 * blip clears by itself, while a revoked token does not — hence the budget,
 * which stops the retries after half a minute rather than polling forever.
 *
 * Running checks are also transient, but they are already covered by
 * `checks.pending`, which polls without a budget because a check can legitimately
 * take longer than the budget allows.
 *
 * This set used to hold sentences — "Required checks are still pending" and
 * three others — that merge readiness had never once produced, so the whole
 * warm-up path was unreachable. Codes cannot drift that way.
 */
const TRANSIENT_MERGE_BLOCKER_CODES: ReadonlySet<MergeBlockerCode> =
  new Set<MergeBlockerCode>(["github-unavailable"]);

export const MERGE_READINESS_POLL_INTERVAL_MS = 5_000;
export const MERGE_READINESS_TRANSIENT_MAX_POLLS = 6;

type MergeReadinessPollingState = {
  canMerge: boolean;
  blockers: MergeBlocker[];
  pr: { number: number } | null;
  checkRuns: unknown[];
  checks: {
    requiredTotal: number;
    pending: number;
    failed: number;
  };
};

function hasTransientMergeBlocker(
  readiness: MergeReadinessPollingState,
): boolean {
  return [...TRANSIENT_MERGE_BLOCKER_CODES].some((code) =>
    hasBlocker(readiness.blockers, code),
  );
}

export function shouldIncrementMergeReadinessTransientPollCount(
  readiness: MergeReadinessPollingState | null,
): boolean {
  if (
    !readiness ||
    readiness.canMerge ||
    readiness.checks.pending > 0 ||
    readiness.checks.failed > 0
  ) {
    return false;
  }

  return hasTransientMergeBlocker(readiness);
}

export function shouldPollMergeReadiness(params: {
  readiness: MergeReadinessPollingState | null;
  transientPollCount: number;
}): boolean {
  const { readiness, transientPollCount } = params;

  if (!readiness) {
    return false;
  }

  /*
   * Checked before `pr`, not after: a call that failed has no pull request to
   * report, so a missing `pr` here means "we couldn't ask GitHub", not "there
   * is nothing to merge". Requiring `pr` first is what left the retry budget
   * below permanently unreachable.
   */
  if (hasTransientMergeBlocker(readiness)) {
    return transientPollCount < MERGE_READINESS_TRANSIENT_MAX_POLLS;
  }

  return readiness.pr !== null && readiness.checks.pending > 0;
}
