import "server-only";

import { reflectOnRecentSessions } from "@/lib/memory/reflect";
import { getOrganization } from "@/lib/org/organization";
import { getBoss } from "./queue";

/**
 * Daily reflection job (spec Section 4 Task 6).
 *
 * Registered once at server startup, same as the email worker
 * (`workers.ts`): a queue, a worker consuming it, and a cron `schedule()`
 * that pg-boss uses to enqueue a job onto that queue on its own. Paco is
 * single-organisation per install (`lib/org/organization.ts`), so the
 * worker resolves the one organisation itself rather than the schedule
 * carrying an id that could go stale.
 */

const QUEUE_NAME = "reflection";

/** Runs once a day; see the task brief for why 04:00 (low-traffic hours). */
const DAILY_AT_4AM_CRON = "0 4 * * *";

let started: Promise<void> | null = null;

async function registerReflectionJob(): Promise<void> {
  const boss = await getBoss();

  await boss.createQueue(QUEUE_NAME).catch(() => {
    // Idempotent; the queue may already exist.
  });

  // schedule() itself upserts by queue name, so calling this again on every
  // boot (or from a concurrent caller — see `started` below) does not create
  // duplicate schedules.
  await boss.schedule(QUEUE_NAME, DAILY_AT_4AM_CRON);

  await boss.work(
    QUEUE_NAME,
    { batchSize: 1 },
    async (jobs: Array<{ data: object }>) => {
      for (const _job of jobs) {
        const organization = await getOrganization();
        if (!organization) {
          continue;
        }
        await reflectOnRecentSessions({ organizationId: organization.id });
      }
    },
  );

  console.log("[jobs] reflection job registered");
}

/** Start the reflection job. Safe to call more than once. */
export function startReflectionJob(): Promise<void> {
  if (!started) {
    started = registerReflectionJob().catch((error) => {
      // Reset so a later boot can retry instead of silently never working.
      started = null;
      throw error;
    });
  }

  return started;
}
