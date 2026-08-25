import type { TaskStatus } from "@/lib/db/schema";

/** The bound on automatic reviewer rejections before a task blocks for a human. */
const MAX_REVIEWER_REJECTIONS = 2;

/**
 * Every legal (from, to) pair in the task board's state machine.
 *
 * This is the single source of truth `canTransition` reads (Section 3 Global
 * Constraints, binding): `todo → running → review → done`, with `blocked`
 * reachable from `running` (approval pending) and `failed` reachable from
 * `running`/`review`, `review → running` on reviewer rejection. Plus two
 * edges Task 8's UI needs and this task ships: `failed → todo` (a human
 * retry) and `blocked → running` (a human unblock). No other transitions
 * exist — a status never transitions to itself, and `done` is terminal.
 */
const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(["running"]),
  running: new Set(["review", "blocked", "failed"]),
  review: new Set(["done", "running", "failed"]),
  blocked: new Set(["running"]),
  failed: new Set(["todo"]),
  done: new Set(),
};

/** Pure check: is `from -> to` a legal edge of the task state machine? */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from].has(to);
}

export type ReviewerVerdict = "pass" | "fail";

export type ReviewerVerdictInput = {
  status: TaskStatus;
  reviewerRejections: number;
};

export type ReviewerVerdictResult = {
  status: TaskStatus;
  reviewerRejections: number;
};

/**
 * Applies a reviewer's verdict to a task currently in `review`.
 *
 * `pass` always moves to `done`, leaving `reviewerRejections` as a record of
 * how many times the task was sent back before it succeeded. `fail` moves
 * back to `running` for another executor attempt, incrementing the counter —
 * unless it has already reached `MAX_REVIEWER_REJECTIONS`, in which case the
 * task blocks for a human instead of looping automatically forever, and the
 * counter is left as-is (it is already at, or past, the cap).
 */
export function nextOnReviewerVerdict(
  current: ReviewerVerdictInput,
  verdict: ReviewerVerdict,
): ReviewerVerdictResult {
  if (verdict === "pass") {
    return { status: "done", reviewerRejections: current.reviewerRejections };
  }
  if (current.reviewerRejections < MAX_REVIEWER_REJECTIONS) {
    return {
      status: "running",
      reviewerRejections: current.reviewerRejections + 1,
    };
  }
  return { status: "blocked", reviewerRejections: current.reviewerRejections };
}
