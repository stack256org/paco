import "server-only";

import { PgBoss, type SendOptions } from "pg-boss";
import { postgresUrl } from "@/lib/db/url";

/**
 * Background job queue.
 *
 * Backed by the same Postgres the app already requires, so self-hosting stays a
 * single dependency. pg-boss owns its own schema (`pgboss`) and does not touch
 * the application tables.
 */

/** Queue names. Keep them centralized so producers and workers cannot drift. */
export const QUEUES = {
  /**
   * One queue for every cron schedule (`lib/db/schema.ts`'s `schedules`
   * table). Each schedule row registers its own pg-boss cron entry on this
   * queue, keyed by the schedule's id (`lib/jobs/schedule-job.ts`), rather
   * than getting a queue of its own — a queue per schedule would mean
   * creating and dropping pg-boss queues as schedules come and go, where a
   * single `key`-scoped registration is exactly what pg-boss's own
   * `schedule()`/`unschedule()` API is for.
   */
  fireSchedule: "fire-schedule",
} as const;

/**
 * Cached on `globalThis` for the same reason as the Drizzle pool: a
 * module-level variable does not survive a Turbopack rebuild in development,
 * so each edit started a second pg-boss with its own connections until
 * Postgres refused new clients outright.
 */
const globalForBoss = globalThis as typeof globalThis & {
  __pacoBoss?: Promise<PgBoss>;
};

/**
 * Start (or reuse) the shared pg-boss instance.
 *
 * Memoized because `start()` runs migrations and opens a pool; calling it per
 * request would exhaust connections.
 *
 * Only a *successful* start is memoized. Caching the promise unconditionally
 * meant that if Postgres was unreachable for the one moment the first job was
 * enqueued — which is normal on boot, where the app and the database start
 * together — the rejected promise stayed on `globalThis` for the life of the
 * process. Every later call got that same rejection back, so a schedule never
 * fired until someone restarted Paco, long after Postgres had recovered.
 *
 * `startScheduleJob` already resets its own flag on failure so a later boot
 * can retry; that retry went through this function and got the poisoned
 * promise, so the care taken there had no effect.
 */
export function getBoss(): Promise<PgBoss> {
  if (globalForBoss.__pacoBoss) {
    return globalForBoss.__pacoBoss;
  }

  const boss = new PgBoss({
    connectionString: postgresUrl(),
    schema: "pgboss",
    // Schedule dispatch is low volume; it does not need a wide pool, and
    // every connection here is one the app cannot use.
    max: 2,
  });

  // Without a listener pg-boss throws on background errors and takes the
  // process down with it.
  boss.on("error", (error: unknown) => {
    console.error("[jobs] pg-boss error:", error);
  });

  const starting = boss
    .start()
    .then(() => boss)
    .catch((error: unknown) => {
      // Forget this attempt so the next caller starts a fresh one. Guarded on
      // identity so a retry already in flight is not cleared by a straggler.
      if (globalForBoss.__pacoBoss === starting) {
        globalForBoss.__pacoBoss = undefined;
      }
      throw error;
    });

  globalForBoss.__pacoBoss = starting;
  return starting;
}

/** Enqueue a job. Returns the job id, or null when pg-boss de-duplicates it. */
export async function enqueue<T extends object>(
  queue: string,
  data: T,
  options?: SendOptions,
): Promise<string | null> {
  const boss = await getBoss();
  await boss.createQueue(queue).catch(() => {
    // createQueue is idempotent; ignore "already exists".
  });
  return boss.send(queue, data, options ?? {});
}
