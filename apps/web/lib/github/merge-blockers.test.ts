import { describe, expect, test } from "bun:test";
import {
  canForceMerge,
  checksFailingBlocker,
  checksRunningBlocker,
  githubUnavailableBlocker,
  hasBlocker,
  isForceBypassable,
  type MergeBlockerCode,
  mergeBlocker,
  nonBypassableBlockers,
} from "./merge-blockers";

/**
 * Every code and whether GitHub will merge past it.
 *
 * A `Record` rather than two arrays so that adding a code to the union stops
 * compiling here: a new blocker nobody classified would otherwise default to
 * "cannot be merged past" and silently hide the button again.
 */
const EXPECTED_BYPASSABILITY: Record<MergeBlockerCode, boolean> = {
  "checks-failing": true,
  "checks-running": true,
  "not-open": false,
  draft: false,
  conflicts: false,
  "no-pull-request": false,
  "github-not-connected": false,
  "github-unavailable": false,
  "workspace-not-running": false,
  "no-repository": false,
};

describe("isForceBypassable", () => {
  test.each(Object.entries(EXPECTED_BYPASSABILITY))(
    "%s bypassable: %s",
    (code, bypassable) => {
      expect(isForceBypassable(code as MergeBlockerCode)).toBe(bypassable);
    },
  );
});

describe("canForceMerge", () => {
  test("offers a force merge when only checks block it", () => {
    expect(
      canForceMerge([checksFailingBlocker(2), checksRunningBlocker(1)]),
    ).toBe(true);
  });

  test("withholds it when a refusal is mixed in", () => {
    expect(
      canForceMerge([checksFailingBlocker(2), mergeBlocker("conflicts")]),
    ).toBe(false);
  });

  test("withholds it when a draft is the only blocker", () => {
    expect(canForceMerge([mergeBlocker("draft")])).toBe(false);
  });

  test("withholds it when nothing is blocking — there is nothing to force", () => {
    expect(canForceMerge([])).toBe(false);
  });

  test("withholds it when GitHub could not be reached", () => {
    expect(
      canForceMerge([githubUnavailableBlocker("We couldn't reach GitHub.")]),
    ).toBe(false);
  });
});

describe("nonBypassableBlockers", () => {
  test("keeps only what the user has to act on", () => {
    const blockers = [
      checksRunningBlocker(3),
      mergeBlocker("conflicts"),
      checksFailingBlocker(1),
      mergeBlocker("draft"),
    ];

    expect(nonBypassableBlockers(blockers).map((b) => b.code)).toEqual([
      "conflicts",
      "draft",
    ]);
  });
});

describe("hasBlocker", () => {
  test("finds a conflicts blocker among others", () => {
    expect(
      hasBlocker(
        [checksFailingBlocker(1), mergeBlocker("conflicts")],
        "conflicts",
      ),
    ).toBe(true);
  });

  test("does not find one that is absent", () => {
    expect(hasBlocker([checksFailingBlocker(1)], "conflicts")).toBe(false);
  });

  test("does not find one in an empty list", () => {
    expect(hasBlocker([], "conflicts")).toBe(false);
  });
});

describe("messages", () => {
  test("count the checks, in the right number", () => {
    expect(checksFailingBlocker(1).message).toContain("1 automated check ");
    expect(checksFailingBlocker(3).message).toContain("3 automated checks ");
    expect(checksRunningBlocker(1).message).toContain("check on GitHub is");
    expect(checksRunningBlocker(2).message).toContain("checks on GitHub are");
  });

  test("carry GitHub's own explanation through unchanged", () => {
    const message = "Reconnect GitHub in Settings, then try again.";
    expect(githubUnavailableBlocker(message).message).toBe(message);
  });

  test("say what to do next where there is something to do", () => {
    expect(mergeBlocker("conflicts").message).toContain("Fix conflicts");
    expect(mergeBlocker("draft").message).toContain("Mark it ready for review");
    expect(mergeBlocker("github-not-connected").message).toContain("Settings");
  });
});
