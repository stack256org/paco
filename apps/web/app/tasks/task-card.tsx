import {
  Bot,
  ListChecks,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  Unlock,
} from "lucide-react";
import Link from "next/link";
import type { TaskOrigin } from "@/lib/db/schema";
import type { TaskBoardItem } from "./actions";

/** Small, muted label for where a task came from. */
const ORIGIN_LABEL: Record<TaskOrigin, string> = {
  user: "User",
  planner: "Planner",
  schedule: "Schedule",
  channel: "Channel",
  reflection: "Reflection",
};

type PendingAction = "start" | "start-subtasks" | "retry" | "unblock" | null;

export interface TaskCardProps {
  task: TaskBoardItem;
  pendingAction: PendingAction;
  onStart: () => void;
  onStartSubtasks: () => void;
  onRetry: () => void;
  onUnblock: () => void;
}

/**
 * One task, as a card on its status column.
 *
 * The only status-specific action ever rendered is the single one legal
 * from that status in `lib/tasks/state.ts`: Start only for a `todo` leaf,
 * Retry only for `failed`, Unblock only for `blocked`.
 *
 * A task with children is a planner grouping node, never a unit of work
 * itself (`startTask` refuses it directly), so it gets "Start subtasks"
 * instead of Start — the action that actually applies to it. Without that
 * it had no button and no legal transition out of `todo` at all, which left
 * every plan's root card dead on the board forever.
 */
export function TaskCard({
  task,
  pendingAction,
  onStart,
  onStartSubtasks,
  onRetry,
  onUnblock,
}: TaskCardProps) {
  const busy = pendingAction !== null;

  return (
    <div className="card card-sm border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-2 p-3">
        <p className="text-sm font-medium leading-snug">{task.title}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="badge badge-soft badge-xs gap-1" title="Session">
            {task.sessionTitle}
          </span>
          <span className="badge badge-soft badge-xs gap-1">
            <Sparkles aria-hidden="true" className="size-2.5" />
            {ORIGIN_LABEL[task.origin]}
          </span>
          {task.assignedAgent ? (
            <span className="badge badge-soft badge-xs gap-1">
              <Bot aria-hidden="true" className="size-2.5" />
              {task.assignedAgent}
            </span>
          ) : null}
          {task.reviewerRejections > 0 ? (
            <span className="badge badge-soft badge-warning badge-xs gap-1">
              <TriangleAlert aria-hidden="true" className="size-2.5" />
              {task.reviewerRejections} rejection
              {task.reviewerRejections === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          {task.chatId && task.sessionId ? (
            <Link
              className="link link-hover inline-flex items-center gap-1 text-base-content/60 text-xs"
              href={`/sessions/${task.sessionId}/chats/${task.chatId}`}
            >
              <MessageSquare aria-hidden="true" className="size-3" />
              Open chat
            </Link>
          ) : (
            <span />
          )}

          {task.status === "todo" && task.isLeaf ? (
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={busy}
              onClick={onStart}
              type="button"
            >
              {pendingAction === "start" ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <Play aria-hidden="true" className="size-3" />
              )}
              Start
            </button>
          ) : null}

          {task.status === "todo" && !task.isLeaf ? (
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={busy}
              onClick={onStartSubtasks}
              type="button"
            >
              {pendingAction === "start-subtasks" ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <ListChecks aria-hidden="true" className="size-3" />
              )}
              Start subtasks
            </button>
          ) : null}

          {task.status === "failed" ? (
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={busy}
              onClick={onRetry}
              type="button"
            >
              {pendingAction === "retry" ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <RotateCcw aria-hidden="true" className="size-3" />
              )}
              Retry
            </button>
          ) : null}

          {task.status === "blocked" ? (
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={busy}
              onClick={onUnblock}
              type="button"
            >
              {pendingAction === "unblock" ? (
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                <Unlock aria-hidden="true" className="size-3" />
              )}
              Unblock
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
