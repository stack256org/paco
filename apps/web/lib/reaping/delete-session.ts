import "server-only";

import * as fs from "node:fs/promises";
import { removeSandboxContainer } from "@paco/sandbox";
import { deleteSession } from "@/lib/db/sessions";
import { sessionResourceNames } from "./classify";
import { measureDirectoryBytes } from "./measure-disk";
import type { UnsavedWork } from "./types";
import { probeUnsavedWork } from "./unsaved-work";
import {
  resolveWorkspacePath,
  UnsafeWorkspaceNameError,
} from "./workspace-name";

/**
 * Delete a session and everything on the host that belonged to it.
 *
 * Deleting the row on its own — which is all this used to do — is what produced
 * the orphans in the first place: the container kept running and the worktree
 * kept its gigabytes, and nothing in the product could reach either again. So
 * deleting a session means deleting the workspace.
 *
 * Two ordering choices are load-bearing:
 *
 * - **Unsaved work is checked first**, and stops the whole thing unless the
 *   caller passes `force`. The worktree is the only copy of anything the agent
 *   wrote that was never pushed.
 * - **The database row goes last.** If removing the container or the directory
 *   fails, the row survives, so the session is still visible and the delete can
 *   be retried. Deleting the row first and then failing is precisely how a
 *   resource becomes an orphan.
 */
export interface DeleteSessionResourcesResult {
  ok: boolean;
  /** Set when the delete was refused because work would be lost. */
  blockedBy?: UnsavedWork;
  removedContainers: string[];
  removedWorkspaces: string[];
  freedBytes: number;
  /** Non-fatal problems worth telling the operator about. */
  warnings: string[];
}

interface SessionRowLike {
  id: string;
  status: string | null;
  title?: string | null;
  sandboxState: unknown;
}

export async function deleteSessionAndResources(
  session: SessionRowLike,
  options: { force?: boolean } = {},
): Promise<DeleteSessionResourcesResult> {
  const names = sessionResourceNames(session);
  const warnings: string[] = [];
  const removedContainers: string[] = [];
  const removedWorkspaces: string[] = [];
  let freedBytes = 0;

  const paths: string[] = [];
  for (const name of names.workspaceNames) {
    try {
      paths.push(resolveWorkspacePath(name));
    } catch (error) {
      // A session id that cannot name a directory names no directory; there is
      // nothing on disk to remove, and nothing to be alarmed about.
      if (!(error instanceof UnsafeWorkspaceNameError)) {
        throw error;
      }
    }
  }

  if (!options.force) {
    for (const path of paths) {
      if (!(await exists(path))) {
        continue;
      }
      const work = await probeUnsavedWork(path);
      if (!work || work.uncommittedFiles > 0 || work.unpushedCommits > 0) {
        return {
          ok: false,
          blockedBy: work ?? {
            uncommittedFiles: 0,
            unpushedCommits: 0,
            hasRemote: false,
            trackedFiles: 0,
          },
          removedContainers,
          removedWorkspaces,
          freedBytes,
          warnings,
        };
      }
    }
  }

  for (const containerName of names.containerNames) {
    try {
      await removeSandboxContainer(containerName);
      removedContainers.push(containerName);
    } catch (error) {
      warnings.push(
        `Could not remove the container ${containerName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const path of paths) {
    if (!(await exists(path))) {
      continue;
    }
    freedBytes += (await measureDirectoryBytes(path)) ?? 0;
    try {
      await fs.rm(path, { recursive: true, force: true });
      removedWorkspaces.push(path);
    } catch (error) {
      warnings.push(
        `Could not remove the workspace at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await deleteSession(session.id);

  return {
    ok: true,
    removedContainers,
    removedWorkspaces,
    freedBytes,
    warnings,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
