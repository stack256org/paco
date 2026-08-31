import "server-only";

import { getBoss } from "./queue";

/**
 * Background workers.
 *
 * Registered once at server startup from `instrumentation.ts`. Starts the
 * shared pg-boss instance so it is ready before anything enqueues a job —
 * `lib/jobs/schedule-job.ts` registers the actual `fireSchedule` worker on
 * top of it.
 */

let started: Promise<void> | null = null;

async function registerWorkers(): Promise<void> {
  await getBoss();

  console.log("[jobs] workers started");
}

/** Start background workers. Safe to call more than once. */
export function startWorkers(): Promise<void> {
  if (!started) {
    started = registerWorkers().catch((error) => {
      // Reset so a later boot can retry instead of silently never working.
      started = null;
      throw error;
    });
  }

  return started;
}
