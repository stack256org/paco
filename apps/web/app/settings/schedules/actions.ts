"use server";

import { isAdmin, requireAdmin } from "@/lib/admin/require-admin";
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
 * collaboratively-viewed settings surface.
 *
 * `requireAdmin` (`lib/admin/require-admin.ts`) IS the check; this only adds
 * the organisation a write needs to be scoped to. It used to inline a
 * line-for-line copy of that helper instead of importing it — exactly the
 * duplication its docstring exists to prevent, and exactly how one of the
 * two copies ends up stale after a refactor. Nothing about the behaviour
 * changed with the swap: `requireAdmin` throws `SIGNED_OUT` then `NOT_YOURS`
 * off the same `getServerSession`/`isAdmin` pair the copy did.
 */
async function requireOrgAdmin(): Promise<{
  userId: string;
  organizationId: string;
}> {
  const userId = await requireAdmin();

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

/**
 * The presence checks — the ones that decide which input box to blame.
 *
 * `cron` is checked for emptiness only, deliberately: whether the expression
 * PARSES is settled downstream by `validateCron` (`lib/db/schedules.ts`),
 * which both `createSchedule` and `updateSchedule` call before they write.
 * That is the same `cron-parser` `CronExpressionParser`, with the same
 * `strict: false`, that pg-boss's own `schedule()` validates against
 * internally, so a malformed expression can never reach pg-boss through
 * either write path. Re-parsing it here would be a second, drifting copy of
 * that rule for no gain; both callers already surface the parser's own
 * message as `fieldErrors.cron`.
 */
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
 * Confirms `sessionId` names one of `userId`'s own sessions before it is
 * ever written into a schedule row.
 *
 * Shared by `createScheduleAction` and `updateScheduleAction`: a schedule
 * always fires into a specific session's worktree, so both the initial
 * create and every later edit have to re-check this the same way — an edit
 * that skipped it would let an admin retarget an existing schedule at a
 * session that was never theirs, even though the picker only ever offers
 * their own (`listMySessionsForScheduleAction`).
 */
async function requireOwnSession(
  userId: string,
  sessionId: string,
): Promise<ScheduleActionResult | null> {
  const sessions = await getSessionsByUserId(userId);
  const owned = sessions.some((row) => row.id === sessionId);
  if (!owned) {
    return {
      success: false,
      error: "That session isn't yours.",
      fieldErrors: { sessionId: "That session isn't yours." },
    };
  }
  return null;
}

/**
 * Confirms `assignedAgent`, when given, names a currently-enabled roster
 * agent before it is ever written into a schedule row.
 *
 * Shared by create and edit for the same reason `requireOwnSession` is: an
 * edit is caller input too. A schedule stores the name and `buildTaskPrompt`
 * (`lib/tasks/start.ts`) reads it straight back out — "Delegate this work to
 * the \"<name>\" subagent" — so a name nothing in the roster answers to
 * becomes an instruction to delegate to an agent that does not exist, on
 * every fire, unattended.
 *
 * A hard error rather than the planner's silent null (`lib/tasks/planner.ts`
 * clears an unknown name it invented itself): this is the same situation
 * `createTaskAction` (`app/tasks/actions.ts`) treats as a validation error —
 * a human picked from a list that should only ever have offered valid names,
 * so a name off that list is a bug worth reporting, not noise worth
 * swallowing. Enabled-ness is included: `getRoster` omits disabled rows, so
 * an agent switched off after the schedule was written is rejected on the
 * next edit.
 */
async function requireKnownAgent(
  organizationId: string,
  assignedAgent: string | null | undefined,
): Promise<ScheduleActionResult | null> {
  if (!assignedAgent) {
    return null;
  }
  const roster = await getRoster(organizationId);
  if (assignedAgent in roster) {
    return null;
  }
  const message = `"${assignedAgent}" is not an enabled agent.`;
  return {
    success: false,
    error: message,
    fieldErrors: { assignedAgent: message },
  };
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

  const ownershipError = await requireOwnSession(userId, input.sessionId);
  if (ownershipError) {
    return ownershipError;
  }

  const agentError = await requireKnownAgent(
    organizationId,
    input.assignedAgent,
  );
  if (agentError) {
    return agentError;
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

/**
 * Edits a schedule in place and re-syncs its pg-boss cron registration.
 *
 * Re-checks session ownership (`requireOwnSession`) the same way create
 * does — `sessionId` on an edit is caller input just like it is on create,
 * so it gets the same check, not a lighter one just because a row already
 * exists.
 */
export async function updateScheduleAction(
  scheduleId: string,
  input: ScheduleFormInput,
): Promise<ScheduleActionResult> {
  const { userId, organizationId } = await requireOrgAdmin();

  const validated = validateInput(input);
  if ("success" in validated) {
    return validated;
  }

  const ownershipError = await requireOwnSession(userId, input.sessionId);
  if (ownershipError) {
    return ownershipError;
  }

  const agentError = await requireKnownAgent(
    organizationId,
    input.assignedAgent,
  );
  if (agentError) {
    return agentError;
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
