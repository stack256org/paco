import { describe, expect, test } from "bun:test";
import { TASK_STATUSES, type TaskStatus } from "@/lib/db/schema";
import { canTransition, nextOnReviewerVerdict } from "./state";

/**
 * The complete set of legal (from, to) pairs, written independently of
 * `state.ts`'s own table so this test can't pass by construction. Mirrors
 * the Global Constraints machine verbatim, plus the two Task 8 edges this
 * task ships: `failed → todo` (retry) and `blocked → running` (human
 * unblock).
 *
 * `review → blocked` is part of that machine, not an extra: it is the
 * terminating edge of the bounded rejection loop — `nextOnReviewerVerdict`
 * returns `blocked` once the rejection cap is reached, and the reviewer gate
 * performs exactly that transition. Without it the safety valve is an
 * illegal edge, the gate's transition throws, and the task is stranded in
 * `review` forever (no later turn can move it — `getTaskByChatId` only
 * matches `running` — and the board renders no action for `review`).
 */
const LEGAL_EDGES: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  ["todo", "running"],
  ["running", "review"],
  ["review", "done"],
  ["running", "blocked"],
  ["running", "failed"],
  ["review", "failed"],
  ["review", "running"],
  ["review", "blocked"],
  ["failed", "todo"],
  ["blocked", "running"],
];

const LEGAL_KEYS = new Set(LEGAL_EDGES.map(([from, to]) => `${from}->${to}`));

describe("canTransition", () => {
  for (const [from, to] of LEGAL_EDGES) {
    test(`${from} -> ${to} is legal`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  describe("every other pair is illegal", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const key = `${from}->${to}`;
        if (LEGAL_KEYS.has(key)) {
          continue;
        }
        test(`${from} -> ${to} is illegal`, () => {
          expect(canTransition(from, to)).toBe(false);
        });
      }
    }
  });

  test("no status transitions to itself", () => {
    for (const status of TASK_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  test("done is terminal", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransition("done", to)).toBe(false);
    }
  });
});

describe("nextOnReviewerVerdict", () => {
  test("pass moves review to done, leaving rejections untouched", () => {
    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 0 },
        "pass",
      ),
    ).toEqual({ status: "done", reviewerRejections: 0 });

    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 1 },
        "pass",
      ),
    ).toEqual({ status: "done", reviewerRejections: 1 });
  });

  test("first fail sends it back to running with rejections incremented", () => {
    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 0 },
        "fail",
      ),
    ).toEqual({ status: "running", reviewerRejections: 1 });
  });

  test("second fail sends it back to running with rejections at the cap", () => {
    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 1 },
        "fail",
      ),
    ).toEqual({ status: "running", reviewerRejections: 2 });
  });

  test("third fail blocks for a human instead of retrying again", () => {
    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 2 },
        "fail",
      ),
    ).toEqual({ status: "blocked", reviewerRejections: 2 });
  });

  test("a fail past the cap stays blocked, not looping further", () => {
    expect(
      nextOnReviewerVerdict(
        { status: "review", reviewerRejections: 5 },
        "fail",
      ),
    ).toEqual({ status: "blocked", reviewerRejections: 5 });
  });
});
