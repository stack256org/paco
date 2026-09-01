"use client";

import { AlertTriangle, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  createScheduleAction,
  deleteScheduleAction,
  listSchedulesAction,
  runScheduleNowAction,
  type ScheduleRow,
  setScheduleEnabledAction,
  updateScheduleAction,
} from "./actions";
import { ScheduleEditorDialog } from "./schedule-editor-dialog";
import { ScheduleRow as ScheduleRowView } from "./schedule-row";

/**
 * The interactive half of `/settings/schedules`.
 *
 * A client component fetching its own data — same shape as
 * `AgentsPageContent` — so every mutation updates this in-memory list
 * without a full page reload.
 */
export function SchedulesPageContent() {
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleRow | null>(
    null,
  );
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const loadSchedules = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const rows = await listSchedulesAction();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setSchedules(rows);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the schedules.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadSchedules]);

  function openCreateDialog() {
    setEditingSchedule(null);
    setDialogOpen(true);
  }

  function openEditDialog(schedule: ScheduleRow) {
    setEditingSchedule(schedule);
    setDialogOpen(true);
  }

  async function handleToggleEnabled(schedule: ScheduleRow, enabled: boolean) {
    setTogglingId(schedule.id);
    const previous = schedules;
    setSchedules(
      (rows) =>
        rows?.map((row) =>
          row.id === schedule.id ? { ...row, enabled } : row,
        ) ?? rows,
    );

    try {
      const result = await setScheduleEnabledAction(schedule.id, enabled);
      if (!result.success) {
        setSchedules(previous);
        toast.error(result.error);
      }
    } catch {
      setSchedules(previous);
      toast.error(`${schedule.name} could not be updated.`);
    } finally {
      setTogglingId(null);
    }
  }

  async function handleRunNow(schedule: ScheduleRow) {
    setRunningId(schedule.id);
    try {
      const result = await runScheduleNowAction(schedule.id);
      if (result.success) {
        toast.success(`${schedule.name} fired.`);
        void loadSchedules();
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error(`${schedule.name} could not be run.`);
    } finally {
      setRunningId(null);
    }
  }

  async function handleDelete(schedule: ScheduleRow) {
    setDeletingId(schedule.id);
    const previous = schedules;
    setSchedules(
      (rows) => rows?.filter((row) => row.id !== schedule.id) ?? rows,
    );

    try {
      const result = await deleteScheduleAction(schedule.id);
      if (!result.success) {
        setSchedules(previous);
        toast.error(result.error);
      }
    } catch {
      setSchedules(previous);
      toast.error(`${schedule.name} could not be deleted.`);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSave(input: Parameters<typeof createScheduleAction>[0]) {
    return editingSchedule
      ? updateScheduleAction(editingSchedule.id, input)
      : createScheduleAction(input);
  }

  const columnCount = 6;

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="mt-1 text-sm text-base-content/60">
            Cron schedules that fire a task on their own — &ldquo;run the suite
            nightly and open a fix PR if it&apos;s red&rdquo; as a config row.
          </p>
        </div>
        <button className="btn btn-sm" onClick={openCreateDialog} type="button">
          <Plus aria-hidden="true" className="size-4" />
          New schedule
        </button>
      </div>

      {loadError ? (
        <div className="alert alert-error alert-soft mt-4" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>The schedules couldn&apos;t be loaded.</span>
          <button
            className="btn btn-sm"
            onClick={() => void loadSchedules()}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-base-300">
          <table className="table table-sm">
            <thead>
              <tr className="text-base-content/60">
                <th>Schedule</th>
                <th>Cron</th>
                <th>Agent</th>
                <th>Last fired</th>
                <th>Enabled</th>
                <th className="text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {schedules === null ? (
                <tr>
                  <td
                    className="py-8 text-center text-base-content/60"
                    colSpan={columnCount}
                  >
                    Loading…
                  </td>
                </tr>
              ) : null}
              {schedules?.length === 0 ? (
                <tr>
                  <td
                    className="py-8 text-center text-base-content/60"
                    colSpan={columnCount}
                  >
                    No schedules yet.
                  </td>
                </tr>
              ) : null}
              {schedules?.map((schedule) => (
                <ScheduleRowView
                  canManage
                  deleting={deletingId === schedule.id}
                  key={schedule.id}
                  onDelete={() => void handleDelete(schedule)}
                  onEdit={() => openEditDialog(schedule)}
                  onRunNow={() => void handleRunNow(schedule)}
                  onToggleEnabled={(enabled) =>
                    void handleToggleEnabled(schedule, enabled)
                  }
                  running={runningId === schedule.id}
                  schedule={schedule}
                  togglingEnabled={togglingId === schedule.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ScheduleEditorDialog
        onOpenChange={setDialogOpen}
        onSave={handleSave}
        onSaved={() => void loadSchedules()}
        open={dialogOpen}
        schedule={editingSchedule}
      />
    </>
  );
}
