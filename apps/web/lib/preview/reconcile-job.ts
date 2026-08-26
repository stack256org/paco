import "server-only";

import { previewStackStatus, syncPreviewRoutes } from "./nginx-reload";

/**
 * The periodic reconciliation the rest of the preview stack was written
 * assuming existed.
 *
 * `provisioning.ts` promised "the periodic lifecycle sweep will pick this up"
 * and there was no such sweep anywhere — not in `lib/jobs/`, not in
 * `instrumentation.ts`. `syncPreviewRoutes` therefore ran at exactly one
 * moment, cold sandbox provisioning.
 *
 * That is not enough, because nginx's preview config is *derived* state and
 * several of its inputs change with no trigger at all:
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
 *
 * So: edge triggers for latency, and this level-triggered sweep for
 * correctness. The sweep is the authority; the edge triggers only make the
 * common case fast.
 *
 * An in-process timer rather than a pg-boss cron job (`lib/jobs/`): every
 * item above is state on *this host* — this machine's nginx, this machine's
 * containers — so it must run in every app process on every host, which is
 * the opposite of what a queue-distributed job guarantees. pg-boss's cron
 * granularity is a minute, too, and none of this touches shared state that
 * two hosts could race over.
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
 * The timer itself keeps running when this is disarmed. On a development
 * checkout that leaves it doing nothing, which is deliberate: the probe is
 * per-process and the alternative — tearing down the timer — would need
 * rebuilding if a sweep ever grows a second step again.
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

/** One full sweep. Never throws — a failed sweep must not stop the next one. */
export async function reconcilePreviewState(): Promise<void> {
  try {
    await syncPreviewRoutesWhereInstalled();
  } catch (error) {
    console.error("[preview-reconcile] preview route sync failed:", error);
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
