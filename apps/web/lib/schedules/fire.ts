import "server-only";

import { createTask } from "@/lib/db/tasks";
import { getScheduleById, stampScheduleFired } from "@/lib/db/schedules";
import { startTask } from "@/lib/tasks/start";

export type FireScheduleResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string };

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
 * disabled, and a `null` outcome for the fire path in general when nothing
 * is supposed to fire, so it never needs its own separate "why didn't this
 * count" check at the call sites.
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
    return { ok: false, error: `Schedule "${scheduleId}" not found` };
  }
  if (!schedule.enabled) {
    return { ok: false, error: `Schedule "${scheduleId}" is disabled` };
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
    return { ok: false, error: result.error };
  }
  return { ok: true, taskId: task.id };
}
