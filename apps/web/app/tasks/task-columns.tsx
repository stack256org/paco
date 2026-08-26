import { TASK_STATUSES, type TaskStatus } from "@/lib/db/schema";
import type { TaskBoardItem } from "./actions";
import { TaskCard } from "./task-card";

/** Column labels and order — `TASK_STATUSES` (`lib/db/schema.ts`) is the source of truth. */
const COLUMN_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  failed: "Failed",
};

/** How many skeleton placeholders a loading column shows. */
const SKELETON_ROWS = [0, 1];

export type PendingAction = "start" | "start-subtasks" | "retry" | "unblock";

export interface TaskColumnsProps {
  /** `null` while the first load is in flight — renders column skeletons. */
  tasks: TaskBoardItem[] | null;
  pending: Record<string, PendingAction | undefined>;
  onStart: (taskId: string) => void;
  /** Starts every `todo` leaf under a planner grouping node. */
  onStartSubtasks: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onUnblock: (taskId: string) => void;
}

/**
 * The pure, presentational half of the board: given a task list, groups it
 * into its six status columns and renders one `TaskCard` per task.
 *
 * A separate file from `task-board.tsx` (which owns fetching, mutation, and
 * toasts through `./actions`) for the same reason `AgentEditorForm` is split
 * from `AgentEditorDialog`: `./actions` is a `"use server"` file whose real
 * dependency chain reaches a live Postgres client and workflow machinery, so
 * this component — and its test, `task-columns.test.tsx` — can only be
 * exercised against fixture data without pulling all of that in if nothing
 * here imports `./actions` as a value, only as a type (erased at compile
 * time).
 */
export function TaskColumns({
  tasks,
  pending,
  onStart,
  onStartSubtasks,
  onRetry,
  onUnblock,
}: TaskColumnsProps) {
  const columns: Record<TaskStatus, TaskBoardItem[]> = {
    todo: [],
    running: [],
    blocked: [],
    review: [],
    done: [],
    failed: [],
  };
  for (const task of tasks ?? []) {
    columns[task.status].push(task);
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
      {TASK_STATUSES.map((status) => (
        <div
          className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-base-200/40 p-2"
          key={status}
        >
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-medium uppercase tracking-wider text-base-content/60">
              {COLUMN_LABEL[status]}
            </h2>
            <span className="badge badge-soft badge-xs">
              {columns[status].length}
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
            {tasks === null
              ? SKELETON_ROWS.map((row) => (
                  <div
                    className="h-20 animate-pulse rounded-lg bg-base-200"
                    key={`${status}-skeleton-${row}`}
                  />
                ))
              : columns[status].map((task) => (
                  <TaskCard
                    key={task.id}
                    onRetry={() => onRetry(task.id)}
                    onStart={() => onStart(task.id)}
                    onStartSubtasks={() => onStartSubtasks(task.id)}
                    onUnblock={() => onUnblock(task.id)}
                    pendingAction={pending[task.id] ?? null}
                    task={task}
                  />
                ))}
          </div>
        </div>
      ))}
    </div>
  );
}
