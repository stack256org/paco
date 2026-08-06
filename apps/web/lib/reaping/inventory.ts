import "server-only";

import { listSandboxContainers, workspaceRoot } from "@paco/sandbox";
import { listSessionResourceRows } from "@/lib/db/session-resources";
import {
  classifyContainers,
  classifyWorkspaces,
  planReclaim,
  sessionResourceNames,
  summarize,
} from "./classify";
import { listWorkspaceDirectories, snapshotWorkspaces } from "./measure-disk";
import type { ContainerSnapshot, StorageReport } from "./types";
import { probeUnsavedWork } from "./unsaved-work";

/**
 * What Paco is actually using on this machine, right now.
 *
 * Three reads — the sessions table, Docker, the workspace root — and then the
 * pure classification in `./classify`. Nothing here decides anything; it only
 * gathers, so that the deciding stays testable.
 *
 * Docker failing is reported rather than thrown. The container half and the
 * disk half are independent, and an operator whose daemon is down still needs
 * to see how much disk their worktrees are holding — a page that 500s because
 * Docker is unreachable tells them nothing at all.
 */
export async function buildStorageReport(): Promise<StorageReport> {
  const root = workspaceRoot();

  const sessions = (await listSessionResourceRows()).map((row) =>
    sessionResourceNames(row),
  );

  let containerSnapshots: ContainerSnapshot[] = [];
  let dockerError: string | null = null;
  try {
    containerSnapshots = await listSandboxContainers();
  } catch (error) {
    dockerError =
      error instanceof Error ? error.message : "Docker could not be reached.";
  }

  const workspaceSnapshots = await snapshotWorkspaces(
    await listWorkspaceDirectories(root),
    probeUnsavedWork,
  );

  const containers = classifyContainers(containerSnapshots, sessions);
  const workspaces = classifyWorkspaces(workspaceSnapshots, sessions);
  const plan = planReclaim({ containers, workspaces });

  return {
    workspaceRoot: root,
    containers,
    workspaces,
    plan,
    totals: summarize({ containers, workspaces, plan }),
    dockerError,
    measuredAtMs: Date.now(),
  };
}
