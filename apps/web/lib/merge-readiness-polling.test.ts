import { describe, expect, test } from "bun:test";
import {
  checksFailingBlocker,
  checksRunningBlocker,
  githubUnavailableBlocker,
  mergeBlocker,
  type MergeBlocker,
} from "./github/merge-blockers";
import {
  MERGE_READINESS_TRANSIENT_MAX_POLLS,
  shouldIncrementMergeReadinessTransientPollCount,
  shouldPollMergeReadiness,
} from "./merge-readiness-polling";

const baseReadiness = {
  canMerge: false,
  blockers: [] as MergeBlocker[],
  pr: { number: 42 } as { number: number } | null,
  checkRuns: [] as unknown[],
  checks: {
    requiredTotal: 0,
    pending: 0,
    failed: 0,
  },
};

describe("merge readiness polling", () => {
  test("keeps polling while checks are still running", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [checksRunningBlocker(1)],
          checks: {
            requiredTotal: 2,
            pending: 1,
            failed: 0,
          },
        },
        transientPollCount: MERGE_READINESS_TRANSIENT_MAX_POLLS,
      }),
    ).toBe(true);
  });

  test("retries a failed GitHub call even though it reported no pull request", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [githubUnavailableBlocker("We couldn't reach GitHub.")],
          pr: null,
        },
        transientPollCount: 0,
      }),
    ).toBe(true);
  });

  test("stops retrying after the budget is exhausted", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [githubUnavailableBlocker("We couldn't reach GitHub.")],
          pr: null,
        },
        transientPollCount: MERGE_READINESS_TRANSIENT_MAX_POLLS,
      }),
    ).toBe(false);
  });

  test("does not keep polling when checks are failing", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [checksFailingBlocker(1)],
          checkRuns: [{ id: 1 }],
          checks: {
            requiredTotal: 1,
            pending: 0,
            failed: 1,
          },
        },
        transientPollCount: 0,
      }),
    ).toBe(false);
  });

  test("does not poll a mergeable pull request", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: { ...baseReadiness, canMerge: true },
        transientPollCount: 0,
      }),
    ).toBe(false);
  });

  test("increments the retry count only while waiting on a transient failure", () => {
    expect(
      shouldIncrementMergeReadinessTransientPollCount({
        ...baseReadiness,
        blockers: [githubUnavailableBlocker("We couldn't reach GitHub.")],
        pr: null,
      }),
    ).toBe(true);

    expect(
      shouldIncrementMergeReadinessTransientPollCount({
        ...baseReadiness,
        blockers: [checksRunningBlocker(1)],
        checks: {
          requiredTotal: 1,
          pending: 1,
          failed: 0,
        },
      }),
    ).toBe(false);
  });

  test("does not poll for stable blocked states", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [mergeBlocker("conflicts")],
        },
        transientPollCount: 0,
      }),
    ).toBe(false);
  });

  test("does not poll a chat with no pull request", () => {
    expect(
      shouldPollMergeReadiness({
        readiness: {
          ...baseReadiness,
          blockers: [mergeBlocker("no-pull-request")],
          pr: null,
        },
        transientPollCount: 0,
      }),
    ).toBe(false);
  });
});
