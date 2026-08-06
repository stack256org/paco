"use client";

import { AlertTriangle, HardDrive, RefreshCw } from "lucide-react";
import type {
  DiskHealth,
  InstanceStorageHealth,
  SandboxHealth,
} from "@/lib/admin/health-actions";
import { formatBytes, pluralize } from "@/lib/reaping/format-bytes";
import { HealthCard } from "./health-card";
import { UnavailableNotice } from "./health-notice";
import { useInstanceStorageHealth } from "./use-instance-storage-health";

/**
 * Disk and sandbox containers, reusing the same measurement the Admin page's
 * storage section takes — this card only reports it.
 *
 * Unlike the other three cards on this page, this one does not load when the
 * page does. Measuring walks every workspace with `du`, up to 120 seconds
 * each, serially, plus a Docker call — by far the most expensive thing this
 * page can do, and it used to gate the whole page's first paint behind it.
 * It is now an explicit "Measure" control, matching how
 * `app/settings/admin/storage-section.tsx` already treats the same
 * measurement.
 *
 * Read-only: reclaiming space is the Admin page's job
 * (`app/settings/admin/storage-section.tsx`), not this one's.
 */
export function StorageCard() {
  const { storage, isLoading, measuredAtMs, error, measure } =
    useInstanceStorageHealth();

  return (
    <HealthCard icon={HardDrive} title="Storage & containers">
      <div className="space-y-4">
        {error ? (
          <div className="alert alert-error alert-soft" role="alert">
            <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {storage ? (
          <StorageBody storage={storage} />
        ) : (
          <NotMeasuredYet isLoading={isLoading} />
        )}

        <div className="flex items-center justify-between gap-3 border-base-content/10 border-t pt-3">
          <p className="text-base-content/50 text-xs">
            {measuredAtMs === null
              ? "Not measured yet."
              : `Measured at ${new Date(measuredAtMs).toLocaleTimeString()}.`}
          </p>
          <button
            className="btn btn-ghost btn-sm"
            disabled={isLoading}
            onClick={() => void measure()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            {isLoading
              ? "Measuring…"
              : storage
                ? "Measure again"
                : "Measure disk and containers"}
          </button>
        </div>
      </div>
    </HealthCard>
  );
}

function NotMeasuredYet({ isLoading }: { isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <div className="skeleton h-20 w-full" />
        <div className="skeleton h-20 w-full" />
      </div>
    );
  }

  return (
    <p className="text-base-content/60 text-sm">
      Walking every workspace with <code>du</code> and asking Docker for
      container sizes is the most expensive check on this page, so it does not
      run automatically. Measure it when you need it.
    </p>
  );
}

function StorageBody({ storage }: { storage: InstanceStorageHealth }) {
  return (
    <>
      <div>
        <h3 className="mb-2 font-medium text-base-content/70 text-sm">
          Workspaces
        </h3>
        {storage.disk.status === "unavailable" ? (
          <UnavailableNotice reason="workspace disk usage could not be measured." />
        ) : (
          <DiskStats disk={storage.disk.data} />
        )}
      </div>

      <div className="border-base-content/10 border-t pt-4">
        <h3 className="mb-2 font-medium text-base-content/70 text-sm">
          Sandbox containers
        </h3>
        {storage.sandboxes.status === "unavailable" ? (
          <UnavailableNotice reason="Docker could not be reached, so containers could not be listed — that is not the same as there being none." />
        ) : (
          <SandboxStats sandboxes={storage.sandboxes.data} />
        )}
      </div>
    </>
  );
}

function DiskStats({ disk }: { disk: DiskHealth }) {
  return (
    <div className="space-y-2">
      <div className="stats stats-vertical w-full border border-base-content/10 sm:stats-horizontal">
        <div className="stat">
          <div className="stat-title">Workspaces</div>
          <div className="stat-value text-2xl">
            {formatBytes(disk.workspaceBytes)}
          </div>
          <div className="stat-desc">
            {pluralize(disk.workspaceCount, "folder", "folders")}
          </div>
        </div>
        <div className="stat">
          <div className="stat-title">Reclaimable</div>
          <div className="stat-value text-2xl">
            {formatBytes(disk.reclaimableBytes)}
          </div>
          <div className="stat-desc">
            {pluralize(
              disk.orphanedWorkspaceCount,
              "unclaimed folder",
              "unclaimed folders",
            )}
          </div>
        </div>
      </div>

      {disk.unmeasuredWorkspaceCount > 0 ? (
        <div className="alert alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>
            {pluralize(
              disk.unmeasuredWorkspaceCount,
              "workspace could not be measured",
              "workspaces could not be measured",
            )}{" "}
            and count as 0 in the total above — that is unknown, not empty.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SandboxStats({ sandboxes }: { sandboxes: SandboxHealth }) {
  return (
    <div className="stats stats-vertical w-full border border-base-content/10 sm:stats-horizontal">
      <div className="stat">
        <div className="stat-title">Containers</div>
        <div className="stat-value text-2xl">{sandboxes.containerCount}</div>
        <div className="stat-desc">
          {sandboxes.runningContainerCount} running
        </div>
      </div>
      <div className="stat">
        <div className="stat-title">Written</div>
        <div className="stat-value text-2xl">
          {formatBytes(sandboxes.containerWritableBytes)}
        </div>
        <div className="stat-desc">
          {pluralize(
            sandboxes.orphanedContainerCount,
            "unclaimed container",
            "unclaimed containers",
          )}
        </div>
      </div>
    </div>
  );
}
