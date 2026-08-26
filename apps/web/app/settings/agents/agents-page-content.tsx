"use client";

import type { BackendCapabilities } from "@paco/agent-backend";
import { AlertTriangle, Info, Loader2, Plus } from "lucide-react";
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
import {
  describeRosterBackendSupport,
  formatList,
} from "./roster-backend-support";

export interface AgentsPageContentProps {
  /** Every backend's own capability report — see `RosterBackendNoticeProps`. */
  backends: readonly BackendCapabilities[];
}

export interface RosterBackendNoticeProps {
  /**
   * What every backend a chat can run on reports — `capabilitiesForBackend`
   * for each `CHAT_BACKEND_IDS` entry, computed in `page.tsx` and handed
   * down.
   *
   * Passed rather than imported because those modules are `server-only`
   * (they construct backends that spawn processes), but the reason that
   * matters is the same one `PoolsideProviderSection` gives: everything
   * below is DERIVED from these objects, so this notice cannot claim a chat
   * ignores the roster when the backend says it does not.
   */
  backends: readonly BackendCapabilities[];
  /** The model ids the roster's rows carry; empty while it is still loading. */
  rosterModelIds: readonly string[];
}

/**
 * Say who this roster actually reaches.
 *
 * The page it sits on is an org-wide list of subagents with model tiers and
 * tool sets, and until this existed it said nothing about backends at all —
 * so an admin could tune the roster, switch a chat to a backend that cannot
 * install one, and lose every bit of it with nothing on screen. That is the
 * same silent downgrade `describeBackendLimitations` was written for on
 * /settings/models, and it is derived the same way: off `customAgents`,
 * never off a backend id.
 *
 * Renders nothing when every backend takes the roster — the honest state for
 * a build where nothing is given up, and the reason this is a conditional
 * notice rather than a permanent caption.
 */
export function RosterBackendNotice({
  backends,
  rosterModelIds,
}: RosterBackendNoticeProps) {
  const { honouring, ignoring } = describeRosterBackendSupport(
    backends,
    rosterModelIds,
  );

  if (ignoring.length === 0) {
    return null;
  }

  const unknownModelIds = [
    ...new Set(ignoring.flatMap((backend) => backend.unknownModelIds)),
  ].sort();

  return (
    <div className="alert alert-info alert-soft mt-4" role="note">
      <Info aria-hidden="true" className="size-4 shrink-0" />
      <div className="min-w-0 text-sm">
        <p>
          This roster is passed to{" "}
          {honouring.length > 0 ? (
            <>{formatList(honouring)} chats</>
          ) : (
            <>no backend this build can run</>
          )}
          . A {formatList(ignoring.map((backend) => backend.label))} chat
          delegates to its own agents instead — nothing on this page reaches it,
          and a turn there is not running with fewer agents, it is running with
          different ones.
        </p>
        {unknownModelIds.length > 0 ? (
          <p className="mt-1 opacity-80">
            Its per-agent model tiers below ({formatList(unknownModelIds)}) are
            not ids {formatList(ignoring.map((backend) => backend.label))}{" "}
            accepts either, so they would not survive the switch even if the
            roster did.
          </p>
        ) : null}
      </div>
    </div>
  );
}

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
export function AgentsPageContent({ backends }: AgentsPageContentProps) {
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

      {/*
        Fed the roster's OWN model ids rather than a hardcoded tier list, so
        the sentence about them describes what is actually in the table. It
        is empty on the first paint (the rows are fetched below), which is
        why the notice's second line appears only once there is a roster to
        describe — it says less before it knows, instead of guessing.
      */}
      <RosterBackendNotice
        backends={backends}
        rosterModelIds={
          agents
            ?.map((agent) => agent.definition.model)
            .filter((model): model is string => model !== undefined) ?? []
        }
      />

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
