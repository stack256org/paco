"use server";

import { z } from "zod";
import { buildStorageReport } from "@/lib/reaping/inventory";
import {
  type ContainerReclaimResult,
  reclaimContainers,
  reclaimOrphanedWorkspace,
  type WorkspaceReclaimResult,
} from "@/lib/reaping/reclaim";
import type { StorageReport } from "@/lib/reaping/types";
import { requireAdmin } from "./require-admin";

/**
 * What the admin page is allowed to ask for.
 *
 * The reclaim actions take a *group*, never a list of things to delete. The
 * server rebuilds the report and removes what is in that group at the moment it
 * runs, so a page left open for an hour cannot delete a container that has
 * since been handed to a live session.
 *
 * The one exception is a workspace directory, which is named — there is no
 * bulk form of it, on purpose — and even then the name is only accepted if the
 * freshly built report still lists it as unclaimed.
 */
const containerGroupSchema = z.enum(["orphaned", "stopped"]);

const reclaimWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  acknowledgeUnsavedWork: z.boolean(),
});

export async function getStorageReport(): Promise<StorageReport> {
  await requireAdmin();
  return buildStorageReport();
}

export async function reclaimContainerGroup(
  group: unknown,
): Promise<ContainerReclaimResult & { ok: boolean; error?: string }> {
  await requireAdmin();

  const parsed = containerGroupSchema.safeParse(group);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That isn't something Paco can clean up.",
      removed: [],
      failed: [],
      freedBytes: 0,
    };
  }

  const result = await reclaimContainers(parsed.data);
  return { ok: result.failed.length === 0, ...result };
}

export async function reclaimWorkspaceDirectory(
  input: unknown,
): Promise<WorkspaceReclaimResult> {
  await requireAdmin();

  const parsed = reclaimWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That isn't a workspace Paco can remove." };
  }

  return reclaimOrphanedWorkspace(parsed.data);
}
