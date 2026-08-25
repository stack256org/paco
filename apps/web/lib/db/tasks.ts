import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type Task,
  tasks,
  type TaskOrigin,
  type TaskStatus,
} from "@/lib/db/schema";
import { canTransition } from "@/lib/tasks/state";

/**
 * Thrown by `transitionTaskStatus` when `from -> to` is not a legal edge of
 * the task state machine (`lib/tasks/state.ts`).
 *
 * Naming the failure makes the state-machine invariant visible at call
 * sites and in logs, rather than looking like any other database failure —
 * the same reasoning `PluginGrantEscalationError` uses for the plugin grant
 * invariant.
 */
export class TaskTransitionError extends Error {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(`Task "${taskId}" cannot transition from "${from}" to "${to}"`);
    this.name = "TaskTransitionError";
  }
}

export type CreateTaskInput = {
  organizationId: string;
  sessionId: string;
  title: string;
  goal: string;
  parentTaskId?: string | null;
  assignedAgent?: string | null;
  origin?: TaskOrigin;
  createdBy?: string | null;
};

/** Creates a new task in `todo`, with no chat attached yet. */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      id: nanoid(),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      goal: input.goal,
      assignedAgent: input.assignedAgent ?? null,
      origin: input.origin ?? "user",
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("createTask: insert returned no row");
  }
  return row;
}

/** Fetches one task, scoped to the caller's organization. */
export async function getTask(
  organizationId: string,
  taskId: string,
): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
  return row;
}

export type ListTasksOptions = {
  status?: TaskStatus;
  sessionId?: string;
};

/** Every task in the organization, newest first, optionally filtered. */
export async function listTasks(
  organizationId: string,
  options?: ListTasksOptions,
): Promise<Task[]> {
  const conditions = [eq(tasks.organizationId, organizationId)];
  if (options?.status) {
    conditions.push(eq(tasks.status, options.status));
  }
  if (options?.sessionId) {
    conditions.push(eq(tasks.sessionId, options.sessionId));
  }
  return await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt));
}

/** Extra columns a status transition may set alongside the new status. */
export type TaskTransitionPatch = Partial<
  Pick<
    Task,
    "chatId" | "reviewerRejections" | "resultSummary" | "assignedAgent"
  >
>;

/**
 * Moves a task to a new status, enforcing `canTransition` first.
 *
 * Scoped to the caller's organization: a task id from another organization
 * is treated the same as one that does not exist. `patch` lets a caller set
 * the columns a transition naturally carries alongside it in the same
 * write — e.g. `chatId` when starting a task, or `reviewerRejections` when
 * applying a reviewer verdict — without going around the state-machine
 * check to do it.
 */
export async function transitionTaskStatus(
  organizationId: string,
  taskId: string,
  to: TaskStatus,
  patch?: TaskTransitionPatch,
): Promise<Task> {
  const current = await getTask(organizationId, taskId);
  if (!current) {
    throw new Error(`No task "${taskId}" in organization "${organizationId}"`);
  }
  if (!canTransition(current.status, to)) {
    throw new TaskTransitionError(taskId, current.status, to);
  }

  const [row] = await db
    .update(tasks)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)))
    .returning();
  if (!row) {
    throw new Error(
      `transitionTaskStatus: update returned no row for "${taskId}"`,
    );
  }
  return row;
}

export type TaskTreeNode = Task & { children: TaskTreeNode[] };

/**
 * Assembles a task and its full subtree, recursing on `parentTaskId`.
 *
 * Not organization-scoped by itself — a root id already names one specific
 * row, and every caller reaches it through an org-scoped lookup first (e.g.
 * `listTasks`/`getTask`), so re-checking here would only duplicate that
 * check. One query per node rather than a recursive CTE: planner trees are
 * shallow (a goal decomposed into subtasks, not deeply nested), so the
 * simplicity is worth more than the extra round trips.
 */
export async function taskTree(
  rootId: string,
): Promise<TaskTreeNode | undefined> {
  const [root] = await db.select().from(tasks).where(eq(tasks.id, rootId));
  if (!root) {
    return;
  }
  return { ...root, children: await childrenOf(root.id) };
}

async function childrenOf(parentId: string): Promise<TaskTreeNode[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentId));
  const nodes: TaskTreeNode[] = [];
  for (const row of rows) {
    nodes.push({ ...row, children: await childrenOf(row.id) });
  }
  return nodes;
}
