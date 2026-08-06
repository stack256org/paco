/**
 * What Paco is using on the host, and which of it is safe to take back.
 *
 * Two kinds of resource, deliberately kept apart everywhere below, because they
 * are not equally precious:
 *
 * - A **container** is disposable. The workspace it works on is bind-mounted
 *   from the host, so removing one loses nothing at all — the next connect
 *   recreates it under the same name over the same directory.
 * - A **workspace directory** is the user's generated code. It may hold commits
 *   that exist nowhere else. Removing one is permanent.
 */

/** How a resource relates to the `sessions` table. */
export type ResourceOwnership =
  /** A session row exists and is not archived. */
  | "live"
  /** A session row exists and is archived — it can still be woken up. */
  | "archived"
  /** No session row names this resource. Nothing in the product can reach it. */
  | "orphaned";

/** The host names one session would use, derived from its row. */
export interface SessionResourceNames {
  sessionId: string;
  title: string | null;
  archived: boolean;
  /** Docker container names this session could own, e.g. `paco-sbx-session_x`. */
  containerNames: string[];
  /** Workspace directory names this session could own, e.g. `session_x`. */
  workspaceNames: string[];
}

/** A `paco-sbx-*` container as Docker reports it. */
export interface ContainerSnapshot {
  id: string;
  name: string;
  state: string;
  running: boolean;
  createdAtSeconds: number;
  writableBytes: number;
}

/**
 * Git work in a workspace that exists nowhere but this disk.
 *
 * Counted across the session repository *and* every chat worktree under it,
 * because a chat's branch is checked out in its own directory and a `git
 * status` in the repository says nothing about it.
 */
export interface UnsavedWork {
  /** Files changed or untracked, summed over the repository and its worktrees. */
  uncommittedFiles: number;
  /** Commits on some branch that no remote-tracking ref contains. */
  unpushedCommits: number;
  /** Whether a remote is configured at all. Without one, nothing is backed up. */
  hasRemote: boolean;
  /** Files under version control. Distinguishes a real project from an empty one. */
  trackedFiles: number;
}

/** A directory directly under the workspace root. */
export interface WorkspaceSnapshot {
  /** Directory name, e.g. `session_abc`. */
  name: string;
  /** Absolute path on the host. */
  path: string;
  /**
   * Real measured size, from `du`. Never estimated, and — when `measured` is
   * false — never trusted either: it is `0`, the same value a genuinely
   * empty directory would report, so it must not be summed into a total
   * without also carrying `measured` alongside it.
   */
  sizeBytes: number;
  /** False when `du` failed and `sizeBytes` is a placeholder zero, not a real measurement. */
  measured: boolean;
  modifiedAtMs: number;
  /** Null when the probe could not run — treated as "assume there is work". */
  unsavedWork: UnsavedWork | null;
}

export interface ClassifiedContainer extends ContainerSnapshot {
  ownership: ResourceOwnership;
  sessionId: string | null;
  sessionTitle: string | null;
}

export interface ClassifiedWorkspace extends WorkspaceSnapshot {
  ownership: ResourceOwnership;
  sessionId: string | null;
  sessionTitle: string | null;
  /** True when there is, or might be, work here that exists nowhere else. */
  mayHoldUnsavedWork: boolean;
}

/** What an operator may reclaim, split by how safe each group is. */
export interface ReclaimPlan {
  /**
   * Containers no session row names. Safe to remove outright: nothing in the
   * product can reach them, and a container holds no data of its own.
   */
  orphanedContainers: ClassifiedContainer[];
  /**
   * Stopped containers belonging to sessions that still exist. Also safe —
   * resuming recreates the container — but it costs the next start a rebuild,
   * so it is a separate, less obvious action.
   */
  stoppedContainers: ClassifiedContainer[];
  /**
   * Workspace directories no session row names. Never removed in bulk: each one
   * is somebody's code, so they are listed individually with their size and
   * their unsaved work, and taken one at a time.
   */
  orphanedWorkspaces: ClassifiedWorkspace[];
}

export interface StorageReport {
  workspaceRoot: string;
  containers: ClassifiedContainer[];
  workspaces: ClassifiedWorkspace[];
  plan: ReclaimPlan;
  totals: StorageTotals;
  /** Set when Docker could not be reached; containers is then empty, not zero. */
  dockerError: string | null;
  measuredAtMs: number;
}

export interface StorageTotals {
  workspaceCount: number;
  workspaceBytes: number;
  containerCount: number;
  runningContainerCount: number;
  containerWritableBytes: number;
  /** Bytes that removing everything in the plan would free. */
  reclaimableBytes: number;
  orphanedWorkspaceCount: number;
  orphanedWorkspaceBytes: number;
  orphanedContainerCount: number;
  /**
   * How many workspaces `du` failed to measure. Their `sizeBytes` is folded
   * into `workspaceBytes` and `orphanedWorkspaceBytes` above as `0` — a
   * placeholder, not a real reading — so this count is what makes an
   * "unknown" measurement visible instead of silently reading as clean.
   */
  unmeasuredWorkspaceCount: number;
}
