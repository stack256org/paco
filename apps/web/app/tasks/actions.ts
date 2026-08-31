"use server";

import type { TaskOrigin, TaskStatus } from "@/lib/db/schema";
import { getRoster } from "@/lib/db/roster";
import { getSessionById, getSessions } from "@/lib/db/sessions";
import {
  createTask,
  getTask,
  listTasks,
  TaskTransitionError,
  type TaskTreeNode,
  taskTree,
  transitionTaskStatus,
} from "@/lib/db/tasks";
import { getOrganization } from "@/lib/org/organization";
import { planGoal } from "@/lib/tasks/planner";
import { kickExecutorFixTurn } from "@/lib/tasks/reviewer-gate";
import { startTask } from "@/lib/tasks/start";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One row on the task board, joined with what the board needs to show. */
export type TaskBoardItem = {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  /** Null for a proposal/reflection task that belongs to no session. */
  sessionId: string | null;
  sessionTitle: string;
  chatId: string | null;
  assignedAgent: string | null;
  origin: TaskOrigin;
  reviewerRejections: number;
  /**
   * Why the task ended where it did — the reviewer's approval, the problems
   * that blocked it, the error that failed it. Shown on the card: a blocked
   * card whose reason lives only in a server log is one an operator cannot
   * act on, which is the whole reason it is blocked.
   */
  resultSummary: string | null;
  /** A task with children is a planner grouping node, never startable itself. */
  isLeaf: boolean;
};

/**
 * Every task in the organisation, newest first, joined with each task's
 * session title for display.
 *
 * The board shows the whole organisation's tasks: `listTasks` is scoped to
 * `organizationId`, and the instance has exactly one organisation.
 */
export async function listOrgTasksAction(): Promise<TaskBoardItem[]> {
  const { id: organizationId } = await getOrganization();
  const rows = await listTasks(organizationId);

  const parentIds = new Set<string>();
  for (const row of rows) {
    if (row.parentTaskId) {
      parentIds.add(row.parentTaskId);
    }
  }

  const sessionIds = Array.from(
    new Set(
      rows
        .map((row) => row.sessionId)
        .filter((sessionId): sessionId is string => sessionId !== null),
    ),
  );
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
    sessionTitle: row.sessionId
      ? (sessionTitles.get(row.sessionId) ?? "Unknown session")
      : "No session",
    chatId: row.chatId,
    assignedAgent: row.assignedAgent,
    origin: row.origin,
    reviewerRejections: row.reviewerRejections,
    resultSummary: row.resultSummary,
    isLeaf: !parentIds.has(row.id),
  }));
}

/** Every non-archived session — the "new task" session picker. */
export type MySessionOption = { id: string; title: string };

export async function listMySessionsForTaskAction(): Promise<
  MySessionOption[]
> {
  const sessions = await getSessions();
  return sessions
    .filter((session) => session.status !== "archived")
    .map((session) => ({ id: session.id, title: session.title }));
}

/** Enabled roster agent names, for the "assigned agent" picker. */
export async function listEnabledAgentNamesAction(): Promise<string[]> {
  const { id: organizationId } = await getOrganization();
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
 * `assignedAgent`, when given, must name a currently-enabled roster row —
 * an unrecognised or disabled name is a validation error, not silently
 * dropped, since a direct create (unlike the planner's own best-effort
 * normalization) has a human picking from a list that should already only
 * offer valid names.
 */
export async function createTaskAction(
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const { id: organizationId } = await getOrganization();

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
  if (!session) {
    return { ok: false, error: "That session was not found." };
  }

  if (input.planThisGoal) {
    const result = await planGoal({
      organizationId,
      sessionId: input.sessionId,
      goal,
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
  const { id: organizationId } = await getOrganization();
  return await startTask(organizationId, taskId);
}

export type StartSubtasksResult =
  | { ok: true; started: number }
  | { ok: false; error: string };

/** Every `todo` leaf under these nodes, depth first. */
function todoLeaves(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const found: TaskTreeNode[] = [];
  for (const node of nodes) {
    if (node.children.length === 0) {
      if (node.status === "todo") {
        found.push(node);
      }
    } else {
      found.push(...todoLeaves(node.children));
    }
  }
  return found;
}

/**
 * Starts every `todo` leaf under a planner grouping node.
 *
 * The planner files a root task holding the tree plus one child per unit of
 * work, all `todo` (`planGoal` in `lib/tasks/planner.ts`). The root is not a
 * unit of work — `startTask` refuses a task with children — so it has no
 * legal transition out of `todo` and, before this, no button either: one
 * permanently dead card per plan, and no way to set a whole plan going
 * short of clicking each subtask in turn. This is that affordance.
 *
 * Sequential rather than concurrent: each start creates a chat and, on its
 * first turn, a worktree, and a plan is decomposed into a handful of
 * subtasks, not hundreds.
 *
 * `ok: false` only when NOTHING started — a plan where some subtasks
 * started and others did not has already changed the board, so the caller
 * must refresh rather than treat the whole call as a failure; the subtasks
 * that did not start are still sitting in `todo` with their own Start
 * button, which is where a human would look anyway.
 */
export async function startSubtasksAction(
  taskId: string,
): Promise<StartSubtasksResult> {
  const { id: organizationId } = await getOrganization();

  const node = await taskTree(organizationId, taskId);
  if (!node) {
    return { ok: false, error: `Task "${taskId}" not found` };
  }
  if (node.children.length === 0) {
    return {
      ok: false,
      error: `Task "${taskId}" has no subtasks — start it directly instead.`,
    };
  }

  const leaves = todoLeaves(node.children);
  if (leaves.length === 0) {
    return { ok: false, error: "No subtasks are waiting to start." };
  }

  let started = 0;
  let firstError: string | null = null;
  for (const leaf of leaves) {
    const result = await startTask(organizationId, leaf.id);
    if (result.ok) {
      started += 1;
    } else {
      firstError ??= result.error;
    }
  }

  if (started === 0) {
    return { ok: false, error: firstError ?? "No subtask could be started." };
  }
  return { ok: true, started };
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
  const { id: organizationId } = await getOrganization();
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

export type UnblockTaskOptions = {
  /**
   * The session to attach to a task that has none — a proposal task
   * (`lib/memory/reflect.ts`, `lib/memory/promote.ts`) is created `blocked`
   * with `sessionId: null`, so the human unblocking it is the first person
   * to say which repository the work belongs in. Ignored for a task that
   * already has a session.
   */
  sessionId?: string;
};

/**
 * A human unblock. What that means depends on how far the task got.
 *
 * A task that already has a chat is mid-flight — it was `running` and hit
 * the approval/rejection wall — so unblocking it is `blocked -> running`
 * with `reviewerRejections` reset (the bounded-retry counter that blocked it
 * no longer applies once a human has looked at it) and one executor turn
 * re-kicked on the existing chat via `kickExecutorFixTurn`
 * (`lib/tasks/reviewer-gate.ts`), the same helper the automatic reviewer
 * gate uses for its own `review -> running` retries.
 *
 * A task with NO chat never ran at all, and that is the common case rather
 * than an edge one: every production path into `blocked` at creation time —
 * reflection proposals and org-memory promotion proposals — files a task
 * with no chat and no session. There is no turn to resume, so unblocking it
 * means releasing it into the backlog (`blocked -> todo`, carrying the
 * chosen session) and starting it for real through `startTask`, exactly as
 * the board's own Start button would.
 *
 * Everything is validated BEFORE anything is written. That ordering is the
 * point: this used to perform the `blocked -> running` write first and
 * validate afterwards, so a task whose unblock could never succeed was left
 * `running` with no turn behind it — and `running` has no action on the
 * board, so the task was stranded for good. Now a rejected unblock leaves
 * the task exactly where the human found it, and the two writes that do
 * happen (`blocked -> todo`, then `startTask`'s own `todo -> running`) both
 * end somewhere the board can act on: `startTask` failing leaves the task in
 * `todo`, which renders Start.
 */
export async function unblockTaskAction(
  taskId: string,
  options?: UnblockTaskOptions,
): Promise<StartTaskResult> {
  const { id: organizationId } = await getOrganization();

  const task = await getTask(organizationId, taskId);
  if (!task) {
    return { ok: false, error: `Task "${taskId}" not found` };
  }
  if (task.status !== "blocked") {
    return {
      ok: false,
      error: `Task "${taskId}" is not "blocked" (currently "${task.status}")`,
    };
  }

  const sessionId = task.sessionId ?? options?.sessionId ?? null;
  if (!sessionId) {
    return {
      ok: false,
      error: "Choose a session for this task before continuing it.",
    };
  }

  const session = await getSessionById(sessionId);
  if (!session) {
    return { ok: false, error: `Session "${sessionId}" not found` };
  }

  if (task.chatId) {
    return await resumeBlockedTask(organizationId, task.id, {
      chatId: task.chatId,
      sessionId,
    });
  }

  return await releaseBlockedTaskToTodo(organizationId, task.id, sessionId);
}

/**
 * `blocked -> running` for a task that already has a chat, re-kicking one
 * executor turn on it. A re-kick that fails to start moves the task on to
 * `failed` rather than leaving it claiming to be `running` with nothing
 * behind it — mirroring `startTask`'s own `failTask` fallback.
 */
async function resumeBlockedTask(
  organizationId: string,
  taskId: string,
  chat: { chatId: string; sessionId: string },
): Promise<StartTaskResult> {
  try {
    await transitionTaskStatus(organizationId, taskId, "running", {
      reviewerRejections: 0,
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  try {
    await kickExecutorFixTurn({
      sessionId: chat.sessionId,
      chatId: chat.chatId,
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

  return { ok: true, chatId: chat.chatId };
}

/**
 * `blocked -> todo` for a task that never ran, attaching the session it is
 * to run in and then starting it. `reviewerRejections` is reset for the same
 * reason the resume path resets it: a human has now looked at this.
 */
async function releaseBlockedTaskToTodo(
  organizationId: string,
  taskId: string,
  sessionId: string,
): Promise<StartTaskResult> {
  try {
    await transitionTaskStatus(organizationId, taskId, "todo", {
      sessionId,
      reviewerRejections: 0,
    });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  return await startTask(organizationId, taskId);
}
