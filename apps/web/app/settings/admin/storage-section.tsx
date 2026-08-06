"use client";

import { AlertTriangle, HardDrive, RefreshCw } from "lucide-react";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import { formatBytes, pluralize } from "@/lib/reaping/format-bytes";
import type {
  ClassifiedContainer,
  ClassifiedWorkspace,
  ResourceOwnership,
} from "@/lib/reaping/types";
import { cn } from "@/lib/utils";
import {
  orphanedContainersConfirm,
  orphanedWorkspaceConfirm,
  stoppedContainersConfirm,
} from "./storage-copy";
import { useStorageReport } from "./use-storage-report";

/**
 * What Paco is using on this machine, and what can be taken back.
 *
 * Everything shown here is measured, not derived: `du` for every workspace,
 * Docker's own writable-layer size for every container. Nothing on this page is
 * an estimate, because the whole reason it exists is that an operator had no
 * way to find out — eight abandoned containers and 1.5 GB of worktrees, none of
 * it visible anywhere in the product.
 *
 * Reporting is automatic. Reclaiming never is. Containers can be removed in a
 * group because a container holds nothing — the workspace is bind-mounted from
 * the host. A workspace directory is the user's code and is only ever removed
 * one at a time, with its size and its unsaved work named in the confirmation.
 */
export function StorageSection() {
  const {
    report,
    isLoading,
    error,
    refresh,
    removeContainers,
    removeWorkspace,
  } = useStorageReport();
  const { confirm, dialog } = useDestructiveConfirm();

  const totals = report?.totals;
  const plan = report?.plan;

  async function confirmContainers(
    group: "orphaned" | "stopped",
    containers: ClassifiedContainer[],
  ) {
    const copy =
      group === "orphaned"
        ? orphanedContainersConfirm(containers)
        : stoppedContainersConfirm(containers);

    await confirm({
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      busyLabel: copy.busyLabel,
      destructive: true,
      run: () => removeContainers(group),
    });
  }

  async function confirmWorkspace(workspace: ClassifiedWorkspace) {
    const copy = orphanedWorkspaceConfirm(workspace);

    await confirm({
      title: copy.title,
      description: copy.description,
      confirmLabel: copy.confirmLabel,
      busyLabel: copy.busyLabel,
      destructive: true,
      run: () => removeWorkspace(workspace.name, workspace.mayHoldUnsavedWork),
    });
  }

  return (
    <section className="rounded-lg border border-base-content/10">
      <div className="flex flex-wrap items-start justify-between gap-3 border-base-content/10 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold text-base">
            <HardDrive aria-hidden="true" className="size-4" />
            Disk and containers
          </h2>
          <p className="mt-1 text-base-content/60 text-sm">
            Every workspace and sandbox container on this machine, measured.
            Paco only ever looks at, or touches, its own.
          </p>
        </div>
        <button
          className="btn btn-sm btn-ghost shrink-0"
          disabled={isLoading}
          onClick={() => void refresh()}
          type="button"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {isLoading ? "Measuring…" : "Measure again"}
        </button>
      </div>

      <div className="space-y-5 px-5 py-4">
        {error ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {isLoading && !report ? <MeasuringSkeleton /> : null}

        {report ? (
          <>
            <div className="stats stats-vertical w-full border border-base-content/10 sm:stats-horizontal">
              <div className="stat">
                <div className="stat-title">Workspaces</div>
                <div className="stat-value text-2xl">
                  {formatBytes(totals?.workspaceBytes ?? 0)}
                </div>
                <div className="stat-desc">
                  {pluralize(totals?.workspaceCount ?? 0, "folder", "folders")}{" "}
                  in {report.workspaceRoot}
                  {totals && totals.unmeasuredWorkspaceCount > 0
                    ? ` · ${pluralize(totals.unmeasuredWorkspaceCount, "unmeasured", "unmeasured")}`
                    : ""}
                </div>
              </div>
              <div className="stat">
                <div className="stat-title">Containers</div>
                <div className="stat-value text-2xl">
                  {totals?.containerCount ?? 0}
                </div>
                <div className="stat-desc">
                  {totals?.runningContainerCount ?? 0} running ·{" "}
                  {formatBytes(totals?.containerWritableBytes ?? 0)} written
                </div>
              </div>
              <div className="stat">
                <div className="stat-title">Reclaimable</div>
                <div className="stat-value text-2xl">
                  {formatBytes(totals?.reclaimableBytes ?? 0)}
                </div>
                <div className="stat-desc">
                  {pluralize(
                    totals?.orphanedWorkspaceCount ?? 0,
                    "unclaimed folder",
                    "unclaimed folders",
                  )}{" "}
                  ·{" "}
                  {pluralize(
                    totals?.orphanedContainerCount ?? 0,
                    "unclaimed container",
                    "unclaimed containers",
                  )}
                </div>
              </div>
            </div>

            {report.dockerError ? (
              <div className="alert alert-warning alert-soft" role="alert">
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
                <span>
                  Docker could not be reached, so no container is listed below —
                  that is not the same as there being none. (
                  {report.dockerError})
                </span>
              </div>
            ) : null}

            <ContainerTable
              containers={report.containers}
              onRemove={confirmContainers}
              orphanedCount={plan?.orphanedContainers.length ?? 0}
              plan={plan}
            />

            <WorkspaceTable
              onRemove={confirmWorkspace}
              workspaces={report.workspaces}
            />

            <p className="text-base-content/50 text-xs">
              Measured at {new Date(report.measuredAtMs).toLocaleTimeString()}.
              Sizes come from <code>du</code> and Docker, so they match what
              your terminal reports.
            </p>
          </>
        ) : null}
      </div>

      {dialog}
    </section>
  );
}

function MeasuringSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="skeleton h-24 w-full" />
      <div className="skeleton h-4 w-64" />
      <div className="skeleton h-32 w-full" />
    </div>
  );
}

/**
 * Complete class strings, chosen by a switch.
 *
 * Never assembled from a variable — a class name built at runtime is a class
 * name Tailwind's scanner never saw, so it is not in the stylesheet and the
 * badge silently renders unstyled.
 */
function ownershipBadgeClass(ownership: ResourceOwnership): string {
  switch (ownership) {
    case "orphaned":
      return "badge badge-sm badge-warning";
    case "archived":
      return "badge badge-sm badge-ghost";
    default:
      return "badge badge-sm badge-soft";
  }
}

function ownershipLabel(ownership: ResourceOwnership): string {
  switch (ownership) {
    case "orphaned":
      return "Unclaimed";
    case "archived":
      return "Archived";
    default:
      return "In use";
  }
}

function ContainerTable({
  containers,
  plan,
  orphanedCount,
  onRemove,
}: {
  containers: ClassifiedContainer[];
  plan:
    | {
        orphanedContainers: ClassifiedContainer[];
        stoppedContainers: ClassifiedContainer[];
      }
    | undefined;
  orphanedCount: number;
  onRemove: (
    group: "orphaned" | "stopped",
    containers: ClassifiedContainer[],
  ) => Promise<void>;
}) {
  const stoppedCount = plan?.stoppedContainers.length ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Sandbox containers</h3>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-sm btn-outline"
            disabled={orphanedCount === 0}
            onClick={() =>
              void onRemove("orphaned", plan?.orphanedContainers ?? [])
            }
            type="button"
          >
            Remove {orphanedCount} unclaimed
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={stoppedCount === 0}
            onClick={() =>
              void onRemove("stopped", plan?.stoppedContainers ?? [])
            }
            type="button"
          >
            Remove {stoppedCount} sleeping
          </button>
        </div>
      </div>

      {containers.length === 0 ? (
        <p className="text-base-content/60 text-sm">
          No sandbox containers on this machine.
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-box border border-base-content/10">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Container</th>
                <th>State</th>
                <th>Belongs to</th>
                <th className="text-right">Written</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((container) => (
                <tr key={container.id}>
                  <td className="font-mono text-xs">{container.name}</td>
                  <td>
                    <span className="whitespace-nowrap text-sm">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "status status-sm mr-2",
                          container.running
                            ? "status-success"
                            : "status-neutral",
                        )}
                      />
                      {container.state}
                    </span>
                  </td>
                  <td>
                    <span className={ownershipBadgeClass(container.ownership)}>
                      {ownershipLabel(container.ownership)}
                    </span>
                    {container.sessionTitle ? (
                      <span className="ml-2 text-base-content/60 text-xs">
                        {container.sessionTitle}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-right">
                    {formatBytes(container.writableBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WorkspaceTable({
  workspaces,
  onRemove,
}: {
  workspaces: ClassifiedWorkspace[];
  onRemove: (workspace: ClassifiedWorkspace) => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-sm">Workspace folders</h3>
        <p className="mt-1 text-base-content/60 text-xs">
          These hold the code Paco wrote. An unclaimed folder is one no session
          points at any more; it is removed one at a time, never in a batch, and
          never automatically.
        </p>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-base-content/60 text-sm">
          No workspace folders yet.
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto rounded-box border border-base-content/10">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Folder</th>
                <th>Belongs to</th>
                <th>Unsaved work</th>
                <th className="text-right">Size</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((workspace) => (
                <tr key={workspace.path}>
                  <td className="font-mono text-xs">{workspace.name}</td>
                  <td>
                    <span className={ownershipBadgeClass(workspace.ownership)}>
                      {ownershipLabel(workspace.ownership)}
                    </span>
                    {workspace.sessionTitle ? (
                      <span className="ml-2 text-base-content/60 text-xs">
                        {workspace.sessionTitle}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-sm">
                    <UnsavedWorkCell workspace={workspace} />
                  </td>
                  <td className="text-right">
                    {workspace.measured ? (
                      formatBytes(workspace.sizeBytes)
                    ) : (
                      <span
                        className="tooltip"
                        data-tip="du failed to measure this directory"
                      >
                        <span className="badge badge-ghost badge-sm">
                          Unknown
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {workspace.ownership === "orphaned" ? (
                      <button
                        // Named, because in a list of rows "Delete" alone tells
                        // a screen-reader user nothing about which one.
                        aria-label={`Delete the workspace ${workspace.name}`}
                        className="btn btn-xs btn-outline btn-error"
                        onClick={() => void onRemove(workspace)}
                        type="button"
                      >
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnsavedWorkCell({ workspace }: { workspace: ClassifiedWorkspace }) {
  const work = workspace.unsavedWork;

  if (!work) {
    return (
      <span className="text-warning">
        Could not read — assume there is work
      </span>
    );
  }

  if (!workspace.mayHoldUnsavedWork) {
    return <span className="text-base-content/60">All pushed</span>;
  }

  const parts: string[] = [];
  if (work.uncommittedFiles > 0) {
    parts.push(pluralize(work.uncommittedFiles, "file", "files"));
  }
  if (work.unpushedCommits > 0) {
    parts.push(pluralize(work.unpushedCommits, "commit", "commits"));
  }

  return (
    <span className="text-warning">
      {parts.join(", ")}
      {work.hasRemote ? "" : " · no remote"}
    </span>
  );
}
