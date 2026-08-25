"use client";

import { AlertTriangle, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  listOrgTasksAction,
  retryTaskAction,
  startTaskAction,
  type TaskBoardItem,
  unblockTaskAction,
} from "./actions";
import { NewTaskDialog } from "./new-task-dialog";
import { type PendingAction, TaskColumns } from "./task-columns";
import { UnblockTaskDialog } from "./unblock-task-dialog";

/**
 * The org's task board: one column per status in the state machine
 * (`lib/tasks/state.ts`), each holding the tasks currently in it.
 *
 * A column board rather than a flat, filterable list — the app already
 * groups work this way elsewhere (the session drawer's date groups, the
 * workspace switcher's per-repo groups), and a task's status is the one
 * thing this surface exists to make visible at a glance, which a board
 * shows structurally instead of through a filter a viewer has to reach for.
 * The columns themselves are `TaskColumns` (`./task-columns.tsx`); this
 * component owns fetching, mutation, and toasts.
 *
 * A client component fetching its own data, same shape as
 * `AgentsPageContent` (`app/settings/agents/agents-page-content.tsx`): every
 * mutation refreshes this same in-memory list without a full page reload,
 * and every action still re-checks org membership and the state machine
 * server-side regardless of what this component assumes.
 */
export function TaskBoard() {
  const [tasks, setTasks] = useState<TaskBoardItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState<
    Record<string, PendingAction | undefined>
  >({});
  /**
   * The blocked task whose session the human is being asked to pick, if any.
   *
   * A blocked task that already has a session is unblocked in one click; one
   * with none (every proposal task — see `UnblockTaskDialog`) cannot be, and
   * asking here is what stops those cards accumulating in Blocked forever.
   */
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadTasks = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const rows = await listOrgTasksAction();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setTasks(rows);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the task board.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadTasks]);

  async function runAction(
    taskId: string,
    action: PendingAction,
    run: () => Promise<{ ok: true } | { ok: false; error: string }>,
  ) {
    setPending((prev) => ({ ...prev, [taskId]: action }));
    try {
      const result = await run();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await loadTasks();
    } catch {
      toast.error("That action couldn't be completed.");
    } finally {
      setPending((prev) => ({ ...prev, [taskId]: undefined }));
    }
  }

  /**
   * A task with a session can be unblocked outright; one without needs a
   * session chosen first, which `UnblockTaskDialog` asks for.
   */
  function handleUnblock(taskId: string) {
    const target = tasks?.find((row) => row.id === taskId);
    if (target && !target.sessionId) {
      setUnblockingId(taskId);
      return;
    }
    void runAction(taskId, "unblock", () => unblockTaskAction(taskId));
  }

  const unblockingTask = tasks?.find((row) => row.id === unblockingId) ?? null;

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="mt-1 text-sm text-base-content/60">
            Work items the organisation&apos;s agents are running, reviewing, or
            waiting on.
          </p>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setDialogOpen(true)}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
          New task
        </button>
      </div>

      {loadError ? (
        <div className="alert alert-error alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>The task board couldn&apos;t be loaded.</span>
          <button
            className="btn btn-sm"
            onClick={() => void loadTasks()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <TaskColumns
          onRetry={(taskId) =>
            void runAction(taskId, "retry", () => retryTaskAction(taskId))
          }
          onStart={(taskId) =>
            void runAction(taskId, "start", () => startTaskAction(taskId))
          }
          onUnblock={handleUnblock}
          pending={pending}
          tasks={tasks}
        />
      )}

      <NewTaskDialog
        onCreated={() => void loadTasks()}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />

      <UnblockTaskDialog
        onConfirm={(sessionId) => {
          const taskId = unblockingId;
          if (!taskId) {
            return;
          }
          // Kept open, and `submitting`, until the action resolves — the
          // dialog is the only place its error can be read back.
          void runAction(taskId, "unblock", () =>
            unblockTaskAction(taskId, { sessionId }),
          ).finally(() => setUnblockingId(null));
        }}
        onOpenChange={(open) => {
          if (!open) {
            setUnblockingId(null);
          }
        }}
        submitting={
          unblockingId !== null && pending[unblockingId] === "unblock"
        }
        task={unblockingTask}
      />
    </div>
  );
}
