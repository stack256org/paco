import * as os from "node:os";
import * as path from "node:path";

/**
 * Root directory for Paco's own persisted data (memory today; anything else
 * that isn't a sandbox workspace tomorrow).
 *
 * There is no dedicated "app data dir" helper elsewhere in the codebase —
 * `workspaceRoot()` (`packages/sandbox/docker/connect.ts`) resolves
 * `PACO_WORKSPACE_ROOT`, but that variable is documented as the root that
 * holds *sandbox workspaces* specifically, and the packaged install
 * (`packaging/debian/postinst`) derives it from `PACO_HOME`
 * (`PACO_WORKSPACE_ROOT=$PACO_HOME/workspaces`). `PACO_HOME` is therefore the
 * name already established for "Paco's base data directory" — this reuses it
 * rather than inventing a second env var for the same concept, and mirrors
 * `workspaceRoot()`'s home-relative fallback for local dev.
 */
export function dataDir(): string {
  return (
    process.env.PACO_HOME ??
    // See `workspaceRoot()` for why this needs `turbopackIgnore`: `os.homedir()`
    // can't be resolved statically, and without the hint Next's build-time file
    // tracer decides the whole module is untrustworthy and traces everything.
    path.join(/* turbopackIgnore: true */ os.homedir(), ".paco")
  );
}

/** Project-scope memory directory: git-versioned, inside the session repo. */
export function projectMemoryDir(sessionWorkspaceRepoDir: string): string {
  return path.join(sessionWorkspaceRepoDir, ".paco", "memory");
}

/** User-scope memory directory: in Paco's data dir, keyed by user id. */
export function userMemoryDir(userId: string): string {
  return path.join(dataDir(), "memory", "users", userId);
}

/** Org-scope memory directory: in Paco's data dir, keyed by org id. */
export function orgMemoryDir(organizationId: string): string {
  return path.join(dataDir(), "memory", "orgs", organizationId);
}
