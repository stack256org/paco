import "server-only";

import { workspaceRoot } from "@paco/sandbox";
import { hostWorkspaceFor } from "@/lib/agent/workspace-paths";
import { getChatById, getSessionsWithActiveSandbox } from "@/lib/db/sessions";
import {
  listCandidateWorktrees,
  removeCandidates,
} from "@/lib/design/candidates";
import { listWorkspaceDirectories } from "@/lib/reaping/measure-disk";
import { isSandboxActive } from "@/lib/sandbox/utils";
import {
  CANDIDATE_INDEXES,
  stopCandidateDevServersForSandbox,
} from "./candidate-dev-server";
import { previewStackStatus, syncPreviewRoutes } from "./nginx-reload";

/**
 * The periodic reconciliation the rest of the preview stack was written
 * assuming existed.
 *
 * `provisioning.ts` promised "the periodic lifecycle sweep will pick this up"
 * and there was no such sweep anywhere — not in `lib/jobs/`, not in
 * `instrumentation.ts`. `syncPreviewRoutes` therefore ran at exactly one
 * moment, cold sandbox provisioning, which is the one moment at which no
 * design candidate can possibly exist yet.
 *
 * Adding the edge trigger (`lib/design/candidates.ts` now syncs after
 * creating and removing candidates) fixes the reported symptom but not the
 * class, because nginx's preview config is *derived* state and several of its
 * inputs change with no trigger at all:
 *
 * - A container that stops and starts gets a fresh ephemeral host port from
 *   Docker, so every route's `upstreamPort` goes stale. Only cold
 *   provisioning re-syncs, and `provisioning-kick.ts` skips that entirely
 *   when the sandbox is already up.
 * - A TLS certificate issued after a sync is invisible until the next one:
 *   `existingPreviewCertDir` is read at generation time, and a preview stays
 *   on plain HTTP until something regenerates its block.
 * - Every edge trigger is deliberately best-effort and fire-and-forget — a
 *   host where `nginx -t` fails transiently loses that route with no retry.
 * - Worktrees disappear by paths that never call `removeCandidates` at all:
 *   a process death mid-design-turn, an operator's `rm -rf`, a workspace
 *   reclaim. Their `paco-preview-<slug>-d<n>.conf` files then point at a dead
 *   upstream forever.
 *
 * So: an edge trigger for latency, and this level-triggered sweep for
 * correctness. The sweep is the authority; the edge triggers only make the
 * common case fast.
 *
 * An in-process timer rather than a pg-boss cron job (`lib/jobs/`): every
 * item above is state on *this host* — this machine's nginx, this machine's
 * containers, this machine's disk — so it must run in every app process on
 * every host, which is the opposite of what a queue-distributed job
 * guarantees. pg-boss's cron granularity is a minute, too, and none of this
 * touches shared state that two hosts could race over.
 */

/** How often the sweep runs. */
const RECONCILE_INTERVAL_MS = 60_000;

/** How long after boot the first sweep runs, letting startup settle first. */
const INITIAL_DELAY_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether the nginx step of the sweep is worth attempting on this host.
 *
 * `unchecked` until the first sweep probes the filesystem; the answer is then
 * final for the lifetime of the process, because neither input can change
 * under a running instance without the package being installed or removed
 * underneath it — and either of those restarts the service.
 */
let routeSync: "unchecked" | "armed" | "disarmed" = "unchecked";

/**
 * Reconcile nginx's routes, unless this host has no nginx to reconcile.
 *
 * A development checkout has no `/etc/paco/nginx` and no way to create one, so
 * `syncPreviewRoutes` threw `EACCES` every 60 seconds forever, in the middle
 * of `next dev`'s own output. The fix is not a `catch` — that would hide the
 * identical `EACCES` a real server produces when `postinst`'s `chown paco`
 * did not take, which is a fault an operator has to see. It is to ask, once,
 * whether there is an nginx preview stack here at all (`previewStackStatus`,
 * whose doc comment carries the reasoning for the two signals it reads):
 *
 * - No stack — say so once and never attempt the sync again in this process.
 * - A stack — attempt it every sweep, and let every failure through to the
 *   caller's `console.error`, every time.
 *
 * Only this one step is disarmed, not the timer: the other two things the
 * sweep does — reclaiming candidate ports and orphaned candidate worktrees —
 * are pure Docker and filesystem work that is just as necessary, and just as
 * correct, on a development checkout.
 */
async function syncPreviewRoutesWhereInstalled(): Promise<void> {
  if (routeSync === "disarmed") {
    return;
  }

  if (routeSync === "unchecked") {
    const status = await previewStackStatus();

    if (status.kind === "not-installed") {
      routeSync = "disarmed";
      // Not an error: an environment without previews is a fact about the
      // environment, and `next dev` has enough red in it already.
      console.log(
        `[preview-reconcile] ${status.reason}. Preview route syncing is off for this process; the rest of the sweep still runs.`,
      );
      return;
    }

    if (status.kind === "incomplete") {
      routeSync = "disarmed";
      // A fault, so `console.error` — but printed once rather than every
      // minute, because no amount of retrying re-creates a directory this
      // process is not allowed to create.
      console.error(
        `[preview-reconcile] ${status.reason}. Preview route syncing is off for this process; restart Paco once it is fixed.`,
      );
      return;
    }

    routeSync = "armed";
  }

  await syncPreviewRoutes();
}

/**
 * Reclaim the candidate ports held by dev servers whose worktree is gone.
 *
 * The complement of the stop `removeCandidates` now does directly: this is
 * what catches the candidate whose worktree vanished without anyone calling
 * `removeCandidates` — the process-death case — and the one whose stop failed
 * because the sandbox was briefly unreachable.
 *
 * Only indexes with *no* worktree are touched, so a running design turn is
 * never interfered with, and `stopCandidateDevServers` additionally refuses to
 * kill anything whose working directory is not inside `designs/`, so the
 * chat's own dev server on 5173 is safe.
 */
export async function reapOrphanedCandidateDevServers(): Promise<number> {
  const sessions = (await getSessionsWithActiveSandbox()).filter((session) =>
    isSandboxActive(session.sandboxState),
  );

  let reaped = 0;
  for (const session of sessions) {
    if (!isSandboxActive(session.sandboxState)) {
      // Narrowing only: already excluded by the filter above.
      continue;
    }

    let workspace: string;
    try {
      workspace = hostWorkspaceFor(session.sandboxState);
    } catch {
      continue;
    }

    const live = await listCandidateWorktrees(workspace);
    const liveIndexes = new Set(live.map((candidate) => candidate.index));
    const orphanedIndexes = CANDIDATE_INDEXES.filter(
      (index) => !liveIndexes.has(index),
    );
    if (orphanedIndexes.length === 0) {
      continue;
    }

    const outcomes = await stopCandidateDevServersForSandbox({
      sandboxState: session.sandboxState,
      indexes: orphanedIndexes,
    });
    for (const outcome of outcomes.values()) {
      if (outcome === "stopped") {
        reaped++;
      }
    }
  }

  return reaped;
}

export interface OrphanedCandidateSweep {
  /** Candidate worktrees found on disk, across every workspace. */
  scanned: number;
  /** Those whose chat row is gone; removed, worktree and branch. */
  reclaimed: number;
  /** Those whose chat still exists; left alone — they may hold real work. */
  retained: number;
}

/**
 * Find candidate worktrees nothing in the product can reach, and remove them.
 *
 * "Unreachable" means the chat row is gone: a chat delete whose candidate
 * cleanup failed, or one that pre-dates that cleanup existing. There is no UI
 * anywhere that could reach those worktrees or their branches again, and the
 * reaping subsystem cannot see them because it classifies whole workspaces
 * against the `sessions` table.
 *
 * A candidate whose chat *does* still exist is deliberately left in place,
 * however stale it looks. It may hold the only copy of a design the user
 * asked for, and the honest way to get rid of it is the chat's own Discard
 * control — which is now reachable for as long as candidates exist, rather
 * than only while the design turn is the newest message on screen.
 */
export async function reclaimOrphanedCandidateWorktrees(): Promise<OrphanedCandidateSweep> {
  const sweep: OrphanedCandidateSweep = {
    scanned: 0,
    reclaimed: 0,
    retained: 0,
  };

  // Every workspace directory on disk, not just the sessions with a live
  // sandbox: an orphaned candidate is at its most invisible in a workspace
  // whose session is archived or already gone.
  const workspaces = await listWorkspaceDirectories(workspaceRoot());

  for (const workspace of workspaces) {
    const candidates = await listCandidateWorktrees(workspace.path);
    sweep.scanned += candidates.length;

    const chatIds = [...new Set(candidates.map((c) => c.chatId))];
    for (const chatId of chatIds) {
      const chat = await getChatById(chatId).catch(() => undefined);
      const count = candidates.filter((c) => c.chatId === chatId).length;
      if (chat) {
        sweep.retained += count;
        continue;
      }

      try {
        await removeCandidates({ sessionWorkspace: workspace.path, chatId });
        sweep.reclaimed += count;
      } catch (error) {
        console.error(
          `[preview-reconcile] could not reclaim orphaned design candidates for deleted chat ${chatId}:`,
          error,
        );
      }
    }
  }

  return sweep;
}

/** One full sweep. Never throws — a failed sweep must not stop the next one. */
export async function reconcilePreviewState(): Promise<void> {
  try {
    await syncPreviewRoutesWhereInstalled();
  } catch (error) {
    console.error("[preview-reconcile] preview route sync failed:", error);
  }

  try {
    await reapOrphanedCandidateDevServers();
  } catch (error) {
    console.error("[preview-reconcile] candidate port reclaim failed:", error);
  }

  try {
    const sweep = await reclaimOrphanedCandidateWorktrees();
    if (sweep.reclaimed > 0 || sweep.retained > 0) {
      console.log(
        `[preview-reconcile] design candidates: ${sweep.scanned} on disk, ${sweep.reclaimed} reclaimed, ${sweep.retained} still owned by a live chat`,
      );
    }
  } catch (error) {
    console.error(
      "[preview-reconcile] orphaned candidate worktree sweep failed:",
      error,
    );
  }
}

/**
 * Start the sweep. Safe to call more than once — the second call is a no-op
 * rather than a second timer.
 */
export function startPreviewReconciliation(): void {
  if (timer || initialTimer) {
    return;
  }

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void reconcilePreviewState();
  }, INITIAL_DELAY_MS);
  // Neither timer is a reason to keep the process alive.
  initialTimer.unref?.();

  timer = setInterval(() => {
    void reconcilePreviewState();
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();

  console.log("[jobs] preview reconciliation started");
}

/**
 * Stop the sweep. Exists for tests and for a clean shutdown.
 *
 * Also forgets what the last run learned about this host's nginx, so a
 * stop/start pair behaves like the fresh process it is pretending to be —
 * including printing the "no preview stack here" line again.
 */
export function stopPreviewReconciliation(): void {
  routeSync = "unchecked";
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
