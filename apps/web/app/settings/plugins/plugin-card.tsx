import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { PluginListRow } from "./plugin-list-row";
import type { PluginStatus } from "./plugin-status-action";

interface PluginCardProps {
  plugin: PluginListRow;
  /** The plugin's live host state, polled separately from the row data itself — see `plugins-page-content.tsx`. */
  status: PluginStatus;
  onToggleEnabled: (enabled: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
  togglingEnabled: boolean;
  updating: boolean;
  removing: boolean;
}

const STATUS_BADGE_CLASS: Record<PluginStatus, string> = {
  running: "badge-success",
  starting: "badge-warning",
  crashed: "badge-error",
  stopped: "badge-neutral",
  "not-running": "badge-neutral",
};

function StatusBadge({ status }: { status: PluginStatus }) {
  return (
    <span className={`badge badge-sm ${STATUS_BADGE_CLASS[status]}`}>
      {status}
    </span>
  );
}

/**
 * One installed plugin.
 *
 * A card rather than a table row, unlike `AgentRow`/`ScheduleRow`: granted
 * capabilities are shown as a full badge list, which wants more width and
 * more vertical room than a table cell gives it — this is the one settings
 * list where "what does this thing actually have access to" has to be
 * readable at a glance, not truncated behind a tooltip.
 */
export function PluginCard({
  plugin,
  status,
  onToggleEnabled,
  onUpdate,
  onRemove,
  togglingEnabled,
  updating,
  removing,
}: PluginCardProps) {
  return (
    <div className="space-y-3 rounded-lg border border-base-300 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{plugin.id}</span>
            <span className="badge badge-sm badge-soft">v{plugin.version}</span>
            <StatusBadge status={status} />
          </div>
          <p className="mt-0.5 truncate text-base-content/60 text-xs">
            {plugin.source}
          </p>
        </div>
        <Switch
          aria-label={
            plugin.enabled ? `Disable ${plugin.id}` : `Enable ${plugin.id}`
          }
          checked={plugin.enabled}
          disabled={togglingEnabled}
          onCheckedChange={onToggleEnabled}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {plugin.grantedCapabilities.length === 0 ? (
          <span className="text-base-content/50 text-xs">
            No capabilities granted.
          </span>
        ) : (
          plugin.grantedCapabilities.map((capability) => (
            <span
              className="badge badge-sm badge-soft font-mono"
              key={capability}
            >
              {capability}
            </span>
          ))
        )}
      </div>

      <div className="flex justify-end gap-1">
        <button
          className="btn btn-ghost btn-sm"
          disabled={updating}
          onClick={onUpdate}
          type="button"
        >
          {updating ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
          Update
        </button>
        <button
          aria-label={`Remove ${plugin.id}`}
          className="btn btn-ghost btn-sm"
          disabled={removing}
          onClick={onRemove}
          type="button"
        >
          {removing ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Trash2 aria-hidden="true" className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
