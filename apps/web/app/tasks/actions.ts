"use server";

import { isAdmin } from "@/lib/admin/require-admin";
import type { TaskOrigin, TaskStatus } from "@/lib/db/schema";
import { getRoster } from "@/lib/db/roster";
import { getSessionById, getSessionsByUserId } from "@/lib/db/sessions";
import {
  createTask,
  getTask,
  listTasks,
  TaskTransitionError,
  transitionTaskStatus,
} from "@/lib/db/tasks";
import { NOT_YOURS, SIGNED_OUT } from "@/lib/error-copy";
import { getMemberRole } from "@/lib/org/membership";
import { getOrganization } from "@/lib/org/organization";
import { getServerSession } from "@/lib/session/get-server-session";
import { planGoal } from "@/lib/tasks/planner";
import { kickExecutorFixTurn } from "@/lib/tasks/reviewer-gate";
import { startTask } from "@/lib/tasks/start";

/**
 * The gate on every task-board action.
 *
 * Unlike `requireAdmin` (`lib/admin/require-admin.ts`), any org member may
 * act — tasks are collaborative, not an admin-only surface — so the check
 * is "is this user in the organisation at all", by either an explicit
 * membership row (`getMemberRole`) or the `is_admin` flag (see
 * `promoteMemoryAction` in `lib/memory/promote.ts` for why the flag alone
 * still has to count: a flag-promoted account can legitimately have no
 * membership row). The app is single-org per instance, so "the caller's
 * org" is simply the one organisation this installation has.
 *
 * Throws rather than returning a flag, matching `requireAdmin`: a signed-out
 * or non-member caller is a security boundary, not a normal branch every
 * action would otherwise have to remember to check.
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One row on the task board, joined with what the board needs to show. */
export type TaskBoardItem = {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  sessionId: string;
  sessionTitle: string;
  chatId: string | null;
  assignedAgent: string | null;
  origin: TaskOrigin;
  reviewerRejections: number;
  /** A task with children is a planner grouping node, never startable itself. */
  isLeaf: boolean;
};

/**
 * Every task in the organisation, newest first, joined with each task's
 * session title for display.
 *
 * The board shows the whole organisation's tasks — not just the caller's
 * own — because tasks are collaborative; `listTasks` is already scoped to
 * `organizationId` from `requireOrgMembership`, so there is no cross-org
 * leakage to guard against here.
 */
export async function listOrgTasksAction(): Promise<TaskBoardItem[]> {
  const { organizationId } = await requireOrgMembership();
  const rows = await listTasks(organizationId);

  const parentIds = new Set<string>();
  for (const row of rows) {
    if (row.parentTaskId) {
      parentIds.add(row.parentTaskId);
    }
  }

  const sessionIds = Array.from(new Set(rows.map((row) => row.sessionId)));
  const sessionTitles = new Map<string, string>();
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const session = await getSessionById(sessionId);
      sessionTitles.set(sessionId, session?.title ?? "Unknown session");
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    sessionId: row.sessionId,
    sessionTitle: sessionTitles.get(row.sessionId) ?? "Unknown session",
    chatId: row.chatId,
    assignedAgent: row.assignedAgent,
    origin: row.origin,
    reviewerRejections: row.reviewerRejections,
    isLeaf: !parentIds.has(row.id),
  }));
}

/** One of the caller's own, non-archived sessions — the "new task" session picker. */
export type MySessionOption = { id: string; title: string };

export async function listMySessionsForTaskAction(): Promise<
  MySessionOption[]
> {
  const { userId } = await requireOrgMembership();
  const sessions = await getSessionsByUserId(userId);
  return sessions
    .filter((session) => session.status !== "archived")
    .map((session) => ({ id: session.id, title: session.title }));
}

/** Enabled roster agent names, for the "assigned agent" picker. */
export async function listEnabledAgentNamesAction(): Promise<string[]> {
  const { organizationId } = await requireOrgMembership();
  const roster = await getRoster(organizationId);
  return Object.keys(roster).sort();
}

export type CreateTaskInput = {
  title: string;
  goal: string;
  sessionId: string;
  assignedAgent?: string | null;
  /** When set, `goal` is decomposed by the planner instead of created directly. */
  planThisGoal?: boolean;
};

export type CreateTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string };

/**
 * Creates one task directly, or — with `planThisGoal` — decomposes the goal
 * into a task tree via `planGoal` instead.
 *
 * The session must be one of the caller's own (mirrors the picker
 * `listMySessionsForTaskAction` offers): a session id from another user is
 * rejected here rather than trusted from the client. `assignedAgent`, when
 * given, must name a currently-enabled roster row — an unrecognised or
 * disabled name is a validation error, not silently dropped, since a
 * direct create (unlike the planner's own best-effort normalization) has a
 * human picking from a list that should already only offer valid names.
 */
export async function createTaskAction(
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const { userId, organizationId } = await requireOrgMembership();

  const title = input.title.trim();
  const goal = input.goal.trim();
  if (!goal) {
    return { ok: false, error: "A goal is required." };
  }
  if (!input.planThisGoal && !title) {
    return { ok: false, error: "A title is required." };
  }
  if (!input.sessionId) {
    return { ok: false, error: "Choose a session." };
  }

  const session = await getSessionById(input.sessionId);
  if (!session || session.userId !== userId) {
    return { ok: false, error: "That session was not found." };
  }

  if (input.planThisGoal) {
    const result = await planGoal({
      organizationId,
      sessionId: input.sessionId,
      goal,
      createdBy: userId,
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, taskId: result.rootTaskId };
  }

  let assignedAgent: string | null = null;
  if (input.assignedAgent) {
    const roster = await getRoster(organizationId);
    if (!(input.assignedAgent in roster)) {
      return {
        ok: false,
        error: `"${input.assignedAgent}" is not an enabled agent.`,
      };
    }
    assignedAgent = input.assignedAgent;
  }

  const task = await createTask({
    organizationId,
    sessionId: input.sessionId,
    title,
    goal,
    assignedAgent,
    origin: "user",
    createdBy: userId,
  });

  return { ok: true, taskId: task.id };
}

export type StartTaskResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

/** Starts a `todo` leaf task. `startTask` itself scopes and re-checks every guard. */
export async function startTaskAction(
  taskId: string,
): Promise<StartTaskResult> {
  const { organizationId } = await requireOrgMembership();
  return await startTask(organizationId, taskId);
}

export type TaskActionResult = { ok: true } | { ok: false; error: string };

/**
 * `failed -> todo`: a human asking for another attempt.
 *
 * A plain `transitionTaskStatus` call — nothing else needs resetting, since
 * a task returning to `todo` is started fresh by `startTaskAction`, which
 * creates a brand new chat rather than resuming the failed one.
 */
export async function retryTaskAction(
  taskId: string,
): Promise<TaskActionResult> {
  const { organizationId } = await requireOrgMembership();
  try {
    await transitionTaskStatus(organizationId, taskId, "todo");
    return { ok: true };
  } catch (error) {
    if (error instanceof TaskTransitionError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * `blocked -> running`: a human unblock.
 *
 * Resets `reviewerRejections` to 0 — the bounded-retry counter that got the
 * task blocked in the first place no longer applies once a human has looked
 * at it — and re-kicks one executor turn on the task's existing chat via
 * `kickExecutorFixTurn` (`lib/tasks/reviewer-gate.ts`), the same helper the
 * automatic reviewer gate uses for its own `review -> running` retries. A
 * task can only reach `blocked` from `running`, so its `chatId` is always
 * set by the time this runs.
 *
 * If the re-kick itself fails to start, the task is moved on to `failed`
 * rather than left claiming to be `running` with no turn behind it —
 * mirroring `startTask`'s own `failTask` fallback.
 */
export async function unblockTaskAction(
  taskId: string,
): Promise<StartTaskResult> {
  const { organizationId } = await requireOrgMembership();

  const task = await getTask(organizationId, taskId);
  if (!task) {
    return { ok: false, error: `Task "${taskId}" not found` };
  }
  if (!task.chatId) {
    return { ok: false, error: `Task "${taskId}" has no chat to resume` };
  }

  let updated: Awaited<ReturnType<typeof getTask>>;
  try {
    updated = await transitionTaskStatus(organizationId, taskId, "running", {
      reviewerRejections: 0,
    });
  } catch (error) {
    if (error instanceof TaskTransitionError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: errorMessage(error) };
  }
  if (!updated?.chatId) {
    return { ok: false, error: `Task "${taskId}" has no chat to resume` };
  }
  const chatId = updated.chatId;

  const session = await getSessionById(updated.sessionId);
  if (!session) {
    return { ok: false, error: `Session "${updated.sessionId}" not found` };
  }

  try {
    await kickExecutorFixTurn({
      sessionId: updated.sessionId,
      chatId,
      userId: session.userId,
      problems: ["A human unblocked this task. Continue the work."],
    });
  } catch (error) {
    const message = errorMessage(error);
    try {
      await transitionTaskStatus(organizationId, taskId, "failed", {
        resultSummary: message,
      });
    } catch (transitionError) {
      console.error(
        `Failed to transition task "${taskId}" to "failed":`,
        transitionError,
      );
    }
    return { ok: false, error: message };
  }

  return { ok: true, chatId };
}
