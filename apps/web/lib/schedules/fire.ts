import "server-only";

import { createTask } from "@/lib/db/tasks";
import { getScheduleById, stampScheduleFired } from "@/lib/db/schedules";
import { startTask } from "@/lib/tasks/start";

export type FireScheduleResult =
  | { ok: true; taskId: string }
  | {
      ok: false;
      error: string;
      reason: "not-found" | "disabled" | "start-failed";
    };

/**
 * Fires one schedule: creates a task in its target session (origin
 * `"schedule"`), starts it through the exact same `startTask`
 * (`lib/tasks/start.ts`) path every other task-start goes through, and
 * stamps `lastFiredAt`.
 *
 * Called from two places that both funnel through here rather than
 * duplicating any of this: pg-boss's own per-schedule cron dispatch
 * (the `boss.work` handler in `lib/jobs/schedule-job.ts`, fired on its
 * cron tick) and the settings page's "Run now" action (an on-demand,
 * out-of-band fire of the same schedule). Both call `fireSchedule` with
 * nothing but the schedule id — this is the one place that knows what
 * "firing" means.
 *
 * No catch-up for missed windows: this only ever fires for the tick that
 * is actually happening right now. If the process was down when a 2am
 * cron tick would have fired, or a schedule sat disabled through several
 * would-be ticks, there is no reconciliation pass that later fires once
 * per missed window — the next real tick (or the next "Run now" click) is
 * the only thing that fires it, and `lastFiredAt` only ever reflects the
 * most recent actual fire, never a backfilled history of ticks that were
 * missed. This mirrors pg-boss's own cron semantics: `shouldSendIt`
 * (`timekeeper.js`) compares the schedule's cron against `now`, not
 * against every tick since the schedule last ran.
 *
 * Disabled is checked here too, not just at registration
 * (`lib/jobs/schedule-job.ts`'s `syncScheduleRegistration` unschedules a
 * disabled row from pg-boss) — defense in depth against a job that was
 * already enqueued for this tick the moment before the schedule was
 * disabled. The `reason` field on a failure lets the two callers react
 * differently: `lib/jobs/schedule-job.ts`'s worker treats `"not-found"`
 * specially (see that file) because `schedules.sessionId` cascades on
 * delete — a session getting deleted removes the schedule row with no
 * application code in the loop to call `unregisterSchedule`, so the
 * pg-boss cron entry would otherwise fire forever into a schedule that no
 * longer exists.
 *
 * `lastFiredAt` is stamped as soon as the task exists — "firing" means the
 * schedule produced a task and attempted to start it, whether or not the
 * start itself succeeded — so a `startTask` failure never leaves the
 * schedule looking like it hasn't fired at all. That failure is returned
 * as `{ ok: false }` rather than thrown: a bad session, a full active-turn
 * slot, or any other reason `startTask` can fail is data about this one
 * fire, not an exception that should crash pg-boss's worker loop or the
 * "Run now" server action.
 */
export async function fireSchedule(
  scheduleId: string,
): Promise<FireScheduleResult> {
  const schedule = await getScheduleById(scheduleId);
  if (!schedule) {
    return {
      ok: false,
      error: `Schedule "${scheduleId}" not found`,
      reason: "not-found",
    };
  }
  if (!schedule.enabled) {
    return {
      ok: false,
      error: `Schedule "${scheduleId}" is disabled`,
      reason: "disabled",
    };
  }

  const task = await createTask({
    organizationId: schedule.organizationId,
    sessionId: schedule.sessionId,
    title: schedule.name,
    goal: schedule.goal,
    assignedAgent: schedule.assignedAgent,
    origin: "schedule",
    createdBy: schedule.createdBy,
  });

  await stampScheduleFired(schedule.organizationId, schedule.id, new Date());

  const result = await startTask(schedule.organizationId, task.id);
  if (!result.ok) {
    return { ok: false, error: result.error, reason: "start-failed" };
  }
  return { ok: true, taskId: task.id };
}
