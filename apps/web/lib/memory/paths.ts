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

/**
 * Project-scope memory directory: inside the session's repository checkout,
 * at `.paco/memory`.
 *
 * In the working tree, NOT in git history. This said "git-versioned" and was
 * wrong: `distill.ts` writes the files and `load-for-turn.ts` reads them, and
 * nothing anywhere stages, commits or pushes them. They accumulate as
 * untracked files in one server-side checkout, are never shared with anyone,
 * and go when the workspace does. Retrieval keeps working the whole time,
 * which is why the gap is invisible from inside the product.
 *
 * Left in the working tree deliberately rather than made to auto-commit.
 * The write target is the session repo, checked out on the default branch,
 * which Paco never pushes — its only publish path is a pull request from a
 * chat's worktree branch — so committing here would still share nothing
 * without inventing a branch and push strategy for memory alone. Committing
 * from a chat worktree instead would put distilled notes into the user's
 * feature branch, and from there into the diff a human reviews, on every
 * turn. Neither is a thing to do to someone's repository unattended.
 *
 * The path is a real path in the repository, so anyone who wants this
 * shared and reviewable — which is a reasonable thing to want, and the whole
 * point of project scope — can commit `.paco/memory` themselves. The
 * `/settings/memory` copy says exactly that.
 */
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
