"use server";

import { isAdmin } from "@/lib/admin/require-admin";
import type { Schedule } from "@/lib/db/schema";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  setScheduleEnabled,
  updateSchedule,
} from "@/lib/db/schedules";
import { getSessionsByUserId } from "@/lib/db/sessions";
import { getRoster } from "@/lib/db/roster";
import {
  syncScheduleRegistration,
  unregisterSchedule,
} from "@/lib/jobs/schedule-job";
import { NOT_YOURS, SIGNED_OUT } from "@/lib/error-copy";
import { getMemberRole } from "@/lib/org/membership";
import { getOrganization } from "@/lib/org/organization";
import { fireSchedule } from "@/lib/schedules/fire";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * The gate for every schedule read: any org member, mirroring
 * `requireOrgMembership` in `app/tasks/actions.ts` (schedules are visible to
 * the whole organisation, the same collaborative reasoning tasks use — see
 * that file's docstring for why the flag check has to stay alongside the
 * membership row check).
 */
async function requireOrgMembership(): Promise<{
  userId: string;
  organizationId: string;
}> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error(SIGNED_OUT);
  }
  const userId = session.user.id;

  const organization = await getOrganization();
  if (!organization) {
    throw new Error("There is no organisation yet.");
  }

  const [role, admin] = await Promise.all([
    getMemberRole(userId),
    isAdmin(userId),
  ]);
  if (!role && !admin) {
    throw new Error(NOT_YOURS);
  }

  return { userId, organizationId: organization.id };
}

/**
 * The gate for every schedule write (create, edit, delete, enable/disable,
 * run now): admin only, per this app's usual write/read split for a
 * collaboratively-viewed settings surface (`requireAdmin`,
 * `lib/admin/require-admin.ts`).
 */
async function requireOrgAdmin(): Promise<{
  userId: string;
  organizationId: string;
}> {
  const userId = await (async () => {
    const session = await getServerSession();
    if (!session?.user?.id) {
      throw new Error(SIGNED_OUT);
    }
    if (!(await isAdmin(session.user.id))) {
      throw new Error(NOT_YOURS);
    }
    return session.user.id;
  })();

  const organization = await getOrganization();
  if (!organization) {
    throw new Error("There is no organisation yet.");
  }
  return { userId, organizationId: organization.id };
}

/**
 * One schedule row, for the settings list.
 *
 * Dates are ISO strings, not `Date` instances — the same choice
 * `lib/memory/store.ts`'s `MemoryEntry` makes for its own action-boundary
 * type, so every client component here works with a plain, serializable
 * shape rather than relying on how a `Date` happens to survive the
 * server-action round trip.
 */
export type ScheduleRow = Omit<
  Schedule,
  "lastFiredAt" | "createdAt" | "updatedAt"
> & {
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function toScheduleRow(row: Schedule): ScheduleRow {
  return {
    ...row,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every schedule in the organisation, viewable by any member. */
export async function listSchedulesAction(): Promise<ScheduleRow[]> {
  const { organizationId } = await requireOrgMembership();
  const rows = await listSchedules(organizationId);
  return rows.map(toScheduleRow);
}

/** Whether the caller may create/edit/delete/toggle/run schedules. */
export async function canManageSchedulesAction(): Promise<boolean> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return false;
  }
  return isAdmin(session.user.id);
}

/** One of the caller's own, non-archived sessions — the schedule's session picker. */
export type MySessionOption = { id: string; title: string };

export async function listMySessionsForScheduleAction(): Promise<
  MySessionOption[]
> {
  const { userId } = await requireOrgMembership();
  const sessions = await getSessionsByUserId(userId);
  return sessions
    .filter((session) => session.status !== "archived")
    .map((session) => ({ id: session.id, title: session.title }));
}

/** Enabled roster agent names, for the "assigned agent" picker. */
export async function listEnabledAgentNamesForScheduleAction(): Promise<
  string[]
> {
  const { organizationId } = await requireOrgMembership();
  const roster = await getRoster(organizationId);
  return Object.keys(roster).sort();
}

export type ScheduleFormInput = {
  name: string;
  sessionId: string;
  cron: string;
  goal: string;
  assignedAgent?: string | null;
};

export type ScheduleActionResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: Record<string, string> };

function validateInput(
  input: ScheduleFormInput,
): { name: string; cron: string; goal: string } | ScheduleActionResult {
  const name = input.name.trim();
  const cron = input.cron.trim();
  const goal = input.goal.trim();

  if (!name) {
    return {
      success: false,
      error: "A name is required.",
      fieldErrors: { name: "A name is required." },
    };
  }
  if (!input.sessionId) {
    return {
      success: false,
      error: "Choose a session.",
      fieldErrors: { sessionId: "Choose a session." },
    };
  }
  if (!goal) {
    return {
      success: false,
      error: "A goal is required.",
      fieldErrors: { goal: "A goal is required." },
    };
  }
  if (!cron) {
    return {
      success: false,
      error: "A cron expression is required.",
      fieldErrors: { cron: "A cron expression is required." },
    };
  }
  return { name, cron, goal };
}

/**
 * Creates a schedule, then registers its pg-boss cron entry
 * (`syncScheduleRegistration`) so it actually starts firing — a schedule row
 * with no registration would sit in the database forever without a
 * "Run now" click ever being the only way to fire it, which defeats the
 * point of a cron schedule.
 */
export async function createScheduleAction(
  input: ScheduleFormInput,
): Promise<ScheduleActionResult> {
  const { userId, organizationId } = await requireOrgAdmin();

  const validated = validateInput(input);
  if ("success" in validated) {
    return validated;
  }

  const session = await getSessionsByUserId(userId).then((sessions) =>
    sessions.find((row) => row.id === input.sessionId),
  );
  if (!session) {
    return {
      success: false,
      error: "That session isn't yours.",
      fieldErrors: { sessionId: "That session isn't yours." },
    };
  }

  const result = await createSchedule({
    organizationId,
    sessionId: input.sessionId,
    name: validated.name,
    cron: validated.cron,
    goal: validated.goal,
    assignedAgent: input.assignedAgent ?? null,
    createdBy: userId,
  });
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
      fieldErrors: { cron: result.error },
    };
  }

  await syncScheduleRegistration(result.schedule);
  return { success: true };
}

/** Edits a schedule in place and re-syncs its pg-boss cron registration. */
export async function updateScheduleAction(
  scheduleId: string,
  input: ScheduleFormInput,
): Promise<ScheduleActionResult> {
  const { organizationId } = await requireOrgAdmin();

  const validated = validateInput(input);
  if ("success" in validated) {
    return validated;
  }

  const result = await updateSchedule(organizationId, scheduleId, {
    name: validated.name,
    sessionId: input.sessionId,
    cron: validated.cron,
    goal: validated.goal,
    assignedAgent: input.assignedAgent ?? null,
  });
  if (!result.ok) {
    return {
      success: false,
      error: result.error,
      fieldErrors: { cron: result.error },
    };
  }

  await syncScheduleRegistration(result.schedule);
  return { success: true };
}

/** Enables or disables a schedule, syncing pg-boss's registration to match. */
export async function setScheduleEnabledAction(
  scheduleId: string,
  enabled: boolean,
): Promise<ScheduleActionResult> {
  const { organizationId } = await requireOrgAdmin();

  const row = await setScheduleEnabled(organizationId, scheduleId, enabled);
  if (!row) {
    return { success: false, error: `Schedule "${scheduleId}" not found` };
  }

  await syncScheduleRegistration(row);
  return { success: true };
}

/** Deletes a schedule and removes its pg-boss cron registration entirely. */
export async function deleteScheduleAction(
  scheduleId: string,
): Promise<ScheduleActionResult> {
  const { organizationId } = await requireOrgAdmin();

  const deleted = await deleteSchedule(organizationId, scheduleId);
  if (!deleted) {
    return { success: false, error: `Schedule "${scheduleId}" not found` };
  }

  await unregisterSchedule(scheduleId);
  return { success: true };
}

export type RunScheduleNowResult =
  | { success: true; taskId: string }
  | { success: false; error: string };

/**
 * Fires a schedule immediately, through the exact same `fireSchedule`
 * (`lib/schedules/fire.ts`) path pg-boss's own cron tick uses — this is
 * "Run now", not a separate one-off task-creation code path.
 */
export async function runScheduleNowAction(
  scheduleId: string,
): Promise<RunScheduleNowResult> {
  const { organizationId } = await requireOrgAdmin();

  const schedule = await getSchedule(organizationId, scheduleId);
  if (!schedule) {
    return { success: false, error: `Schedule "${scheduleId}" not found` };
  }

  const result = await fireSchedule(scheduleId);
  if (!result.ok) {
    return { success: false, error: result.error };
  }
  return { success: true, taskId: result.taskId };
}
