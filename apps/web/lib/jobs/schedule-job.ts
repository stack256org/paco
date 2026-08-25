import "server-only";

import type { Schedule } from "@/lib/db/schema";
import { fireSchedule } from "@/lib/schedules/fire";
import { getBoss, QUEUES } from "./queue";

/**
 * Cron dispatch for the `schedules` table (spec Section 6 Task 4).
 *
 * pg-boss ships a first-class per-schedule cron API —
 * `boss.schedule(queueName, cron, data, { key, tz })`,
 * `boss.unschedule(queueName, key)`, `boss.getSchedules(queueName)` (see
 * `timekeeper.js` in the pg-boss package) — that already stores each
 * registration as its own row keyed by `(name, key)`, upserted with
 * `ON CONFLICT (name, key) DO UPDATE` (`plans.js`'s `schedule()`), and
 * already runs its own tick-matching against a cron parser on a polling
 * loop (`cronMonitorIntervalSeconds`, default 30s). That is exactly the
 * "scan every enabled schedule every minute and match its cron against now"
 * mechanism a hand-rolled loop here would have to reinvent — badly, since a
 * hand-rolled version would need its own cron matcher, its own polling
 * interval, and its own de-duplication for "don't fire the same tick
 * twice", all of which pg-boss already has. So this file registers one
 * queue (`QUEUES.fireSchedule`) and gives every schedule row its own
 * registration on it, keyed by the schedule's id — `syncScheduleRegistration`
 * is naturally idempotent (same key = same row, upserted in place) and
 * `unregisterSchedule` removes exactly one row, with no scanning loop of
 * our own anywhere.
 *
 * The actual firing logic (create the task, start it, stamp
 * `lastFiredAt`) lives in `lib/schedules/fire.ts`, not here — this file
 * only owns getting pg-boss to call it at the right times.
 */

let started: Promise<void> | null = null;

async function registerScheduleWorker(): Promise<void> {
  const boss = await getBoss();

  await boss.createQueue(QUEUES.fireSchedule).catch(() => {
    // Idempotent; the queue may already exist.
  });

  await boss.work<{ scheduleId: string }>(
    QUEUES.fireSchedule,
    { batchSize: 5 },
    async (jobs: Array<{ data: { scheduleId: string } }>) => {
      for (const job of jobs) {
        const { scheduleId } = job.data;
        const result = await fireSchedule(scheduleId);
        if (result.ok) {
          continue;
        }

        // Not thrown: `fireSchedule` already created (and attempted to
        // start) the task by the time it can fail, so a pg-boss retry here
        // would fire the schedule a second time for the same tick rather
        // than retry anything idempotently.
        if (result.reason === "not-found") {
          // `schedules.sessionId` cascades on delete, so a session getting
          // deleted removes the schedule row with no application code in
          // the loop to call `unregisterSchedule` — the pg-boss cron entry
          // for it would otherwise survive forever, firing (and failing to
          // find a schedule) on every future tick. Self-heal here instead:
          // the first tick after the row is gone reaps its own
          // registration, so this is a one-time cleanup, not a
          // once-per-tick error. Logged at info level, not error: an
          // orphaned registration catching up with a deleted row is
          // expected housekeeping, not a failure.
          await unregisterSchedule(scheduleId);
          console.log(
            `[jobs] schedule "${scheduleId}" no longer exists; removed its orphaned cron registration`,
          );
          continue;
        }

        // "disabled" is an expected outcome of a race with
        // `syncScheduleRegistration` (already unschedules a disabled row);
        // a `startTask` failure is real but already recorded on the task
        // itself (`lib/tasks/start.ts` moves it to `failed`), so logging
        // here is enough.
        console.error(
          `[jobs] schedule "${scheduleId}" fire did not start a task:`,
          result.error,
        );
      }
    },
  );

  console.log("[jobs] schedule worker started");
}

/** Start the schedule worker. Safe to call more than once. */
export function startScheduleJob(): Promise<void> {
  if (!started) {
    started = registerScheduleWorker().catch((error) => {
      // Reset so a later boot can retry instead of silently never working.
      started = null;
      throw error;
    });
  }

  return started;
}

/**
 * Registers (or updates) one schedule's pg-boss cron entry, or removes it
 * when the schedule is disabled.
 *
 * Called from the settings actions (`app/settings/schedules/actions.ts`)
 * after every create, edit, and enabled/disabled toggle — never from the
 * firing path itself, which only ever reads schedule rows, never writes
 * pg-boss's registration for one. `tz: "UTC"` matches how every timestamp
 * elsewhere in this schema is stored and displayed (no per-organization
 * timezone setting exists to read instead).
 */
export async function syncScheduleRegistration(
  schedule: Pick<Schedule, "id" | "cron" | "enabled">,
): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(QUEUES.fireSchedule).catch(() => {
    // Idempotent; the queue may already exist.
  });

  if (!schedule.enabled) {
    await boss.unschedule(QUEUES.fireSchedule, schedule.id);
    return;
  }

  await boss.schedule(
    QUEUES.fireSchedule,
    schedule.cron,
    { scheduleId: schedule.id },
    { key: schedule.id, tz: "UTC" },
  );
}

/** Removes a schedule's pg-boss cron entry entirely — called on delete. */
export async function unregisterSchedule(scheduleId: string): Promise<void> {
  const boss = await getBoss();
  await boss.unschedule(QUEUES.fireSchedule, scheduleId);
}
