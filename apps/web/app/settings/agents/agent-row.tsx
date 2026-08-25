import {
  Loader2,
  Pencil,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { RosterAgentRow } from "./actions";

interface AgentRowProps {
  agent: RosterAgentRow;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  togglingEnabled: boolean;
  deleting: boolean;
}

/**
 * One roster agent, as a table row.
 *
 * Delete is hidden rather than disabled for a builtin row: `deleteRoster`
 * refuses it outright (see `lib/db/roster.ts`), and a builtin agent can
 * always be reset by editing its definition back, so there is no action a
 * disabled trash icon would ever perform anyway.
 */
export function AgentRow({
  agent,
  onEdit,
  onToggleEnabled,
  onDelete,
  togglingEnabled,
  deleting,
}: AgentRowProps) {
  const { definition } = agent;

  return (
    <tr>
      <td>
        <div className="flex items-center gap-2">
          <button
            className="link link-hover font-medium"
            onClick={onEdit}
            type="button"
          >
            {agent.name}
          </button>
          {agent.builtin ? (
            <span
              className="badge badge-sm badge-soft gap-1"
              title="Builtin agent"
            >
              <ShieldCheck aria-hidden="true" className="size-3" />
              Builtin
            </span>
          ) : null}
          {agent.valid ? null : (
            <span
              className="badge badge-sm badge-soft badge-warning gap-1"
              title="This agent's stored definition is no longer valid and is excluded from every turn until it is fixed."
            >
              <TriangleAlert aria-hidden="true" className="size-3" />
              Invalid
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-md truncate text-base-content/60 text-xs">
          {definition.description}
        </p>
      </td>
      <td>
        <span className="badge badge-sm badge-soft">
          {definition.model ?? "inherit"}
        </span>
      </td>
      <td className="text-base-content/70">{definition.effort ?? "inherit"}</td>
      <td>
        <Switch
          checked={agent.enabled}
          disabled={togglingEnabled}
          onCheckedChange={onToggleEnabled}
        />
      </td>
      <td className="text-right">
        <div className="flex justify-end gap-1">
          <button
            aria-label={`Edit ${agent.name}`}
            className="btn btn-ghost btn-sm"
            onClick={onEdit}
            type="button"
          >
            <Pencil aria-hidden="true" className="size-4" />
          </button>
          {agent.builtin ? null : (
            <button
              aria-label={`Delete ${agent.name}`}
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
          )}
        </div>
      </td>
    </tr>
  );
}
