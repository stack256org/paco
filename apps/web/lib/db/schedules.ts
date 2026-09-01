import "server-only";

import { CronExpressionParser } from "cron-parser";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { type Schedule, schedules } from "@/lib/db/schema";

/**
 * Validates a cron expression with the same parser pg-boss's own
 * `schedule()` call validates against internally (`cron-parser`'s
 * `CronExpressionParser`, see `timekeeper.js` in the pg-boss package) —
 * pg-boss does not re-export that parser from its public API, so it is
 * depended on directly here (same version pg-boss itself pins) rather than
 * reimplementing a regex that would inevitably drift from what pg-boss
 * actually accepts when a schedule is registered
 * (`lib/jobs/schedule-job.ts`). `strict: false` matches pg-boss's own call,
 * accepting both five-field (`* * * * *`) and six-field (seconds-first)
 * expressions.
 */
export function validateCron(
  cron: string,
): { ok: true } | { ok: false; error: string } {
  try {
    CronExpressionParser.parse(cron, { strict: false });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid cron expression: ${message}` };
  }
}

export type CreateScheduleInput = {
  organizationId: string;
  sessionId: string;
  name: string;
  cron: string;
  goal: string;
  assignedAgent?: string | null;
};

export type ScheduleWriteResult =
  | { ok: true; schedule: Schedule }
  | { ok: false; error: string };

/** Creates a new schedule row. Rejects an invalid cron expression before writing. */
export async function createSchedule(
  input: CreateScheduleInput,
): Promise<ScheduleWriteResult> {
  const cronCheck = validateCron(input.cron);
  if (!cronCheck.ok) {
    return { ok: false, error: cronCheck.error };
  }

  const [row] = await db
    .insert(schedules)
    .values({
      id: nanoid(),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      name: input.name,
      cron: input.cron,
      goal: input.goal,
      assignedAgent: input.assignedAgent ?? null,
    })
    .returning();
  if (!row) {
    return { ok: false, error: "createSchedule: insert returned no row" };
  }
  return { ok: true, schedule: row };
}

/** Fetches one schedule, scoped to the caller's organization. */
export async function getSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<Schedule | undefined> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.organizationId, organizationId),
        eq(schedules.id, scheduleId),
      ),
    );
  return row;
}

/**
 * Fetches one schedule by id alone, with no organization scope.
 *
 * Not organization-scoped, the same way `getTaskByChatId`
 * (`lib/db/tasks.ts`) is not: the only caller is the firing path
 * (`lib/schedules/fire.ts`), which is invoked either from pg-boss's own
 * per-schedule cron dispatch (`lib/jobs/schedule-job.ts`) — whose job data
 * carries only the schedule id, never an organization — or from the
 * "Run now" action, which already re-derives its own organization scope
 * from the session before calling in. A schedule id is never taken directly
 * from an unauthenticated request the way this would matter for.
 */
export async function getScheduleById(
  scheduleId: string,
): Promise<Schedule | undefined> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(eq(schedules.id, scheduleId));
  return row;
}

/** Every schedule in the organization, newest first. */
export async function listSchedules(
  organizationId: string,
): Promise<Schedule[]> {
  return await db
    .select()
    .from(schedules)
    .where(eq(schedules.organizationId, organizationId))
    .orderBy(desc(schedules.createdAt));
}

export type UpdateScheduleInput = {
  name: string;
  sessionId: string;
  cron: string;
  goal: string;
  assignedAgent?: string | null;
};

/** Updates a schedule's editable fields in place. Rejects an invalid cron expression. */
export async function updateSchedule(
  organizationId: string,
  scheduleId: string,
  input: UpdateScheduleInput,
): Promise<ScheduleWriteResult> {
  const cronCheck = validateCron(input.cron);
  if (!cronCheck.ok) {
    return { ok: false, error: cronCheck.error };
  }

  const [row] = await db
    .update(schedules)
    .set({
      name: input.name,
      sessionId: input.sessionId,
      cron: input.cron,
      goal: input.goal,
      assignedAgent: input.assignedAgent ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schedules.organizationId, organizationId),
        eq(schedules.id, scheduleId),
      ),
    )
    .returning();
  if (!row) {
    return { ok: false, error: `Schedule "${scheduleId}" not found` };
  }
  return { ok: true, schedule: row };
}

/** Enables or disables a schedule without touching its other fields. */
export async function setScheduleEnabled(
  organizationId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<Schedule | undefined> {
  const [row] = await db
    .update(schedules)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(
        eq(schedules.organizationId, organizationId),
        eq(schedules.id, scheduleId),
      ),
    )
    .returning();
  return row;
}

/** Stamps `lastFiredAt` — called by `fireSchedule` (`lib/schedules/fire.ts`) after a fire. */
export async function stampScheduleFired(
  organizationId: string,
  scheduleId: string,
  firedAt: Date,
): Promise<void> {
  await db
    .update(schedules)
    .set({ lastFiredAt: firedAt, updatedAt: new Date() })
    .where(
      and(
        eq(schedules.organizationId, organizationId),
        eq(schedules.id, scheduleId),
      ),
    );
}

/** Deletes one schedule. Returns whether a row was actually removed. */
export async function deleteSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(schedules)
    .where(
      and(
        eq(schedules.organizationId, organizationId),
        eq(schedules.id, scheduleId),
      ),
    )
    .returning({ id: schedules.id });
  return deleted.length > 0;
}
