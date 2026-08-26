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
 *
 * `review → blocked` is the other half of "`review → running` on reviewer
 * rejection": that loop is BOUNDED (`nextOnReviewerVerdict`, capped at
 * `MAX_REVIEWER_REJECTIONS`), and `blocked` is where it terminates — the one
 * status a human can act on from the board. Leaving it out did not make the
 * cap safer, it made it unreachable: the reviewer gate's transition threw
 * `TaskTransitionError`, the gate logged it as a race, and the task sat in
 * `review` forever with no later turn able to move it (`getTaskByChatId`
 * only matches `running`) and no button to press.
 *
 * `blocked → todo` is the human unblock for a task that never ran: a
 * proposal task (`lib/memory/reflect.ts`, `lib/memory/promote.ts`) is
 * created `blocked`, with no chat and no session, so there is no turn for
 * `blocked → running` to resume. Releasing it into the backlog is what
 * unblocking it means there — see `unblockTaskAction`
 * (`app/tasks/actions.ts`), which then starts it for real.
 */
const LEGAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(["running"]),
  running: new Set(["review", "blocked", "failed"]),
  review: new Set(["done", "running", "blocked", "failed"]),
  blocked: new Set(["running", "todo"]),
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

/** Statuses a task never leaves on its own — nothing but a human moves these. */
const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "failed",
  "blocked",
]);

/**
 * The shortest legal route from one status to another, or `[]` if there is
 * none.
 *
 * A breadth-first walk of `LEGAL_TRANSITIONS` rather than a table of routes:
 * a second table would be a second source of truth about the machine, and
 * the first thing it would do is drift from this one — which is precisely
 * the failure this file just had (`review -> blocked` legal in the reviewer
 * gate's head, missing from the table).
 */
function shortestTransitionPath(
  from: TaskStatus,
  to: TaskStatus,
): TaskStatus[] {
  if (from === to) {
    return [];
  }
  const queue: Array<{ status: TaskStatus; path: TaskStatus[] }> = [
    { status: from, path: [] },
  ];
  const seen = new Set<TaskStatus>([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    for (const next of LEGAL_TRANSITIONS[current.status]) {
      if (seen.has(next)) {
        continue;
      }
      const path = [...current.path, next];
      if (next === to) {
        return path;
      }
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return [];
}

/** What a plan root's children add up to, or `null` if they say nothing yet. */
function planRootTarget(children: TaskStatus[]): TaskStatus | null {
  if (children.length === 0) {
    return null;
  }
  if (children.every((status) => status === "done")) {
    return "done";
  }
  if (children.every((status) => SETTLED_STATUSES.has(status))) {
    // A failure outranks a block: a plan with a failed subtask needs a human
    // for a harder reason than one merely waiting on an approval, and the
    // board's Retry is the affordance that fits.
    return children.includes("failed") ? "failed" : "blocked";
  }
  if (children.some((status) => status !== "todo")) {
    return "running";
  }
  return null;
}

/**
 * The transitions a planner's root task should take to match its children.
 *
 * `planGoal` (`lib/tasks/planner.ts`) files a root task holding the tree
 * plus one child per unit of work. The root is a grouping node, never a unit
 * of work itself — `startTask` refuses a task with children — so nothing
 * drives it: it was created `todo` and stayed `todo` forever, one dead card
 * per plan, even after every subtask under it had finished. This is what
 * drives it, called from `transitionTaskStatus` whenever a child moves.
 *
 * Returns a PATH rather than a single status because some of what a plan
 * does has no single edge: `running -> done` is not a transition (a task
 * reaches `done` through `review`, and inventing a shortcut here would hand
 * every task a way to skip review), so a finished plan travels
 * `review -> done` — the same route `passWithoutReviewer` takes for a task
 * with no reviewer configured. Every step comes from `LEGAL_TRANSITIONS`
 * itself, so a plan can never take an edge an ordinary task could not.
 *
 * A `done` root is never reopened. A `failed` one is: if a human retries a
 * subtask and work is moving again, the plan is alive again, and leaving it
 * `failed` forever would be the same dead-card disease in a different
 * column.
 */
export function nextForPlanRoot(
  current: TaskStatus,
  children: TaskStatus[],
): TaskStatus[] {
  if (current === "done") {
    return [];
  }
  const target = planRootTarget(children);
  if (!target || target === current) {
    return [];
  }
  return shortestTransitionPath(current, target);
}
