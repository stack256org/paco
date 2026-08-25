import { Loader2, Pencil, Play, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { ScheduleRow as ScheduleRowData } from "./actions";

interface ScheduleRowProps {
  schedule: ScheduleRowData;
  /** Only admins may write; a member sees the same row with no action controls. */
  canManage: boolean;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
  togglingEnabled: boolean;
  running: boolean;
  deleting: boolean;
}

function formatLastFired(lastFiredAt: string | null): string {
  if (!lastFiredAt) {
    return "Never";
  }
  return new Date(lastFiredAt).toLocaleString();
}

/** One schedule, as a table row. */
export function ScheduleRow({
  schedule,
  canManage,
  onEdit,
  onToggleEnabled,
  onRunNow,
  onDelete,
  togglingEnabled,
  running,
  deleting,
}: ScheduleRowProps) {
  return (
    <tr>
      <td>
        {canManage ? (
          <button
            className="link link-hover font-medium"
            onClick={onEdit}
            type="button"
          >
            {schedule.name}
          </button>
        ) : (
          <span className="font-medium">{schedule.name}</span>
        )}
        <p className="mt-0.5 max-w-md truncate text-base-content/60 text-xs">
          {schedule.goal}
        </p>
      </td>
      <td>
        <code className="text-xs">{schedule.cron}</code>
      </td>
      <td className="text-base-content/70">
        {schedule.assignedAgent ?? "inherit"}
      </td>
      <td className="text-base-content/70">
        {formatLastFired(schedule.lastFiredAt)}
      </td>
      <td>
        <Switch
          checked={schedule.enabled}
          disabled={!canManage || togglingEnabled}
          onCheckedChange={onToggleEnabled}
        />
      </td>
      {canManage ? (
        <td className="text-right">
          <div className="flex justify-end gap-1">
            <button
              aria-label={`Run ${schedule.name} now`}
              className="btn btn-ghost btn-sm"
              disabled={running || !schedule.enabled}
              onClick={onRunNow}
              title={
                schedule.enabled ? "Run now" : "Enable this schedule to run it"
              }
              type="button"
            >
              {running ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Play aria-hidden="true" className="size-4" />
              )}
            </button>
            <button
              aria-label={`Edit ${schedule.name}`}
              className="btn btn-ghost btn-sm"
              onClick={onEdit}
              type="button"
            >
              <Pencil aria-hidden="true" className="size-4" />
            </button>
            <button
              aria-label={`Delete ${schedule.name}`}
              className="btn btn-ghost btn-sm"
              disabled={deleting}
              onClick={onDelete}
              type="button"
            >
              {deleting ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Trash2 aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}
