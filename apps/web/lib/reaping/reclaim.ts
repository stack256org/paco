import "server-only";

import * as fs from "node:fs/promises";
import { removeSandboxContainer, toContainerName } from "@paco/sandbox";
import { buildStorageReport } from "./inventory";
import type { StorageReport } from "./types";
import { resolveWorkspacePath } from "./workspace-name";

/**
 * The destructive half.
 *
 * One rule governs everything here: **the caller never says what to delete.**
 * It says which *group* it means, and this module rebuilds the report from the
 * database and the host and deletes what is in that group now. A list of names
 * sent from a browser is a list of names that were true when the page rendered;
 * acting on it deletes whatever has since taken those names.
 *
 * The two resource kinds are handled differently on purpose:
 *
 * - Containers go in groups. Removing one loses nothing — the workspace is a
 *   bind mount, and the next connect recreates the container from its name.
 * - Workspace directories go one at a time, each naming itself, and a directory
 *   that might hold work found nowhere else must be acknowledged explicitly.
 *   This is the user's code.
 */

export interface ContainerReclaimResult {
  removed: string[];
  failed: { name: string; error: string }[];
  freedBytes: number;
}

export type ContainerGroup = "orphaned" | "stopped";

export async function reclaimContainers(
  group: ContainerGroup,
  report?: StorageReport,
): Promise<ContainerReclaimResult> {
  const current = report ?? (await buildStorageReport());
  const targets =
    group === "orphaned"
      ? current.plan.orphanedContainers
      : current.plan.stoppedContainers;

  const removed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  let freedBytes = 0;

  for (const container of targets) {
    try {
      await removeSandboxContainer(container.name);
      removed.push(container.name);
      freedBytes += container.writableBytes;
    } catch (error) {
      failed.push({
        name: container.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { removed, failed, freedBytes };
}

export interface WorkspaceReclaimResult {
  ok: boolean;
  error?: string;
  freedBytes?: number;
  /** The container removed alongside it, if there was one. */
  removedContainer?: string;
}

/**
 * Delete one orphaned workspace directory, permanently.
 *
 * Refuses unless the directory is orphaned *at this moment* — a session created
 * since the page loaded takes its name back, and this must not be the thing
 * that deletes it.
 *
 * Refuses again, separately, when the directory may hold unsaved work and the
 * caller has not said it knows. The two checks are not redundant: the first is
 * about who owns the directory, the second about what is inside it.
 *
 * Its container goes too. A container bound to a directory that no longer
 * exists is a fresh leak of exactly the kind this feature exists to end.
 */
export async function reclaimOrphanedWorkspace(params: {
  name: string;
  acknowledgeUnsavedWork: boolean;
  report?: StorageReport;
}): Promise<WorkspaceReclaimResult> {
  const current = params.report ?? (await buildStorageReport());
  const target = current.plan.orphanedWorkspaces.find(
    (workspace) => workspace.name === params.name,
  );

  if (!target) {
    return {
      ok: false,
      error:
        "That workspace is no longer unclaimed. Refresh to see the current state.",
    };
  }

  if (target.mayHoldUnsavedWork && !params.acknowledgeUnsavedWork) {
    return {
      ok: false,
      error:
        "This workspace has work that is not saved anywhere else. Refresh and confirm again to remove it.",
    };
  }

  let path: string;
  try {
    path = resolveWorkspacePath(target.name);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Mapped forwards — the workspace name to the container name Paco would give
  // it — never by parsing a container name back into a workspace name, which is
  // lossy and would let a near-miss remove the wrong container.
  const expectedContainerName = toContainerName(target.name);
  const container = current.plan.orphanedContainers.find(
    (candidate) => candidate.name === expectedContainerName,
  );

  let removedContainer: string | undefined;
  if (container) {
    try {
      await removeSandboxContainer(container.name);
      removedContainer = container.name;
    } catch {
      // The directory is still worth removing; the container stays in the
      // report and can be reclaimed with the others.
    }
  }

  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      removedContainer,
    };
  }

  return { ok: true, freedBytes: target.sizeBytes, removedContainer };
}
