"use client";

import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  deleteRoster,
  type RosterAgentRow,
  listRosterAgents,
  saveRosterAgent,
  setRosterEnabled,
} from "./actions";
import { AgentEditorDialog } from "./agent-editor-dialog";
import { AgentRow } from "./agent-row";

/**
 * The interactive half of `/settings/agents`.
 *
 * A client component fetching its own data — same shape as
 * `HealthPageContent` and `InviteSection` — rather than server-rendered
 * props from `page.tsx`, so every mutation (toggle, save, delete) can update
 * this same in-memory list without a full page reload, and the admin check
 * still runs again on every server action regardless of what this component
 * assumes.
 */
export function AgentsPageContent() {
  const [agents, setAgents] = useState<RosterAgentRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<RosterAgentRow | null>(null);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const loadAgents = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadError(false);
    try {
      const rows = await listRosterAgents();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setAgents(rows);
    } catch {
      if (requestIdRef.current !== requestId) {
        return;
      }
      toast.error("We couldn't load the roster.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadAgents]);

  function openCreateDialog() {
    setEditingAgent(null);
    setDialogOpen(true);
  }

  function openEditDialog(agent: RosterAgentRow) {
    setEditingAgent(agent);
    setDialogOpen(true);
  }

  async function handleToggleEnabled(agent: RosterAgentRow, enabled: boolean) {
    setTogglingName(agent.name);
    const previous = agents;
    setAgents(
      (rows) =>
        rows?.map((row) =>
          row.name === agent.name ? { ...row, enabled } : row,
        ) ?? rows,
    );

    try {
      await setRosterEnabled(agent.name, enabled);
    } catch {
      setAgents(previous);
      toast.error(`${agent.name} could not be updated.`);
    } finally {
      setTogglingName(null);
    }
  }

  async function handleDelete(agent: RosterAgentRow) {
    setDeletingName(agent.name);
    const previous = agents;
    setAgents((rows) => rows?.filter((row) => row.name !== agent.name) ?? rows);

    try {
      const result = await deleteRoster(agent.name);
      if (!result.success) {
        setAgents(previous);
        toast.error(result.error ?? `${agent.name} could not be deleted.`);
      }
    } catch {
      setAgents(previous);
      toast.error(`${agent.name} could not be deleted.`);
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="mt-1 text-sm text-base-content/60">
            The roster this organisation&apos;s chats delegate to. Builtin
            agents can be reconfigured; custom ones can be renamed and removed
            too.
          </p>
        </div>
        <button className="btn btn-sm" onClick={openCreateDialog} type="button">
          <Plus aria-hidden="true" className="size-4" />
          New agent
        </button>
      </div>

      {loadError ? (
        <div className="alert alert-error alert-soft mt-4" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>The roster couldn&apos;t be loaded.</span>
          <button
            className="btn btn-sm"
            onClick={() => void loadAgents()}
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
                <th>Agent</th>
                <th>Model</th>
                <th>Effort</th>
                <th>Enabled</th>
                <th className="text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents === null ? (
                <tr>
                  <td
                    className="py-8 text-center text-base-content/60"
                    colSpan={5}
                  >
                    <Loader2
                      aria-hidden="true"
                      className="mx-auto size-4 animate-spin"
                    />
                  </td>
                </tr>
              ) : null}
              {agents?.length === 0 ? (
                <tr>
                  <td
                    className="py-8 text-center text-base-content/60"
                    colSpan={5}
                  >
                    No agents yet.
                  </td>
                </tr>
              ) : null}
              {agents?.map((agent) => (
                <AgentRow
                  agent={agent}
                  deleting={deletingName === agent.name}
                  key={agent.id}
                  onDelete={() => void handleDelete(agent)}
                  onEdit={() => openEditDialog(agent)}
                  onToggleEnabled={(enabled) =>
                    void handleToggleEnabled(agent, enabled)
                  }
                  togglingEnabled={togglingName === agent.name}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AgentEditorDialog
        agent={editingAgent}
        onOpenChange={setDialogOpen}
        onSave={saveRosterAgent}
        onSaved={() => void loadAgents()}
        open={dialogOpen}
      />
    </>
  );
}
