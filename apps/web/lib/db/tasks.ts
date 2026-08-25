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
import { appendSessionEvents } from "@/lib/db/session-events";
import { canTransition } from "@/lib/tasks/state";

/**
 * Records a task lifecycle event on the task's chat log — but only when
 * the task actually has a chat: `chatId` is null for every task until it
 * starts, and a proposal/reflection task may never get one at all. There is
 * nowhere to append to in that case, so the event is skipped silently
 * (never an error) rather than logged against a chat the task doesn't own.
 * Uses the never-throwing `appendSessionEvents` so recording a task's
 * lifecycle can never fail the mutation that produced it.
 */
async function appendTaskLifecycleEvent(
  chatId: string | null,
  event: Parameters<typeof appendSessionEvents>[1][number],
): Promise<void> {
  if (!chatId) {
    return;
  }
  await appendSessionEvents(chatId, [event]);
}

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
  constructor(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    reason?: string,
  ) {
    super(
      reason ?? `Task "${taskId}" cannot transition from "${from}" to "${to}"`,
    );
    this.name = "TaskTransitionError";
  }
}

/** The only statuses a task may be born in — see `initialStatus` below. */
const CREATABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "todo",
  "blocked",
]);

export type CreateTaskInput = {
  organizationId: string;
  /**
   * Null for a proposal/reflection task that names work to consider rather
   * than a repo to act in yet — see the column comment on `tasks.sessionId`
   * (`lib/db/schema.ts`). `startTask` refuses to start such a task.
   */
  sessionId: string | null;
  title: string;
  goal: string;
  parentTaskId?: string | null;
  assignedAgent?: string | null;
  origin?: TaskOrigin;
  createdBy?: string | null;
  /**
   * The status the task is created in. Defaults to `"todo"`, the normal
   * case. `"blocked"` is for a task that needs a human before any executor
   * should touch it from the moment it exists — e.g. an org memory
   * promotion proposal filed by a non-admin (`lib/memory/promote.ts`) —
   * without faking a `todo -> running -> blocked` status history that never
   * happened. No other value is legal: this is task *creation*, not a
   * transition, so `canTransition` (`lib/tasks/state.ts`) does not apply
   * here and this is validated on its own.
   */
  initialStatus?: "todo" | "blocked";
};

/** Creates a new task, in `todo` unless `initialStatus` says otherwise. */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const initialStatus = input.initialStatus ?? "todo";
  if (!CREATABLE_STATUSES.has(initialStatus)) {
    throw new Error(
      `createTask: invalid initialStatus "${initialStatus}" — must be "todo" or "blocked"`,
    );
  }

  const [row] = await db
    .insert(tasks)
    .values({
      id: nanoid(),
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      goal: input.goal,
      status: initialStatus,
      assignedAgent: input.assignedAgent ?? null,
      origin: input.origin ?? "user",
      createdBy: input.createdBy ?? null,
    })
    .returning();
  if (!row) {
    throw new Error("createTask: insert returned no row");
  }
  await appendTaskLifecycleEvent(row.chatId, {
    type: "task/created",
    taskId: row.id,
    title: row.title,
    origin: row.origin,
  });
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

/**
 * Finds the `running` task that owns a chat, if any.
 *
 * Not organization-scoped: the caller here is a post-turn workflow step that
 * only has the chat id in hand (see `runTaskCompletionStep` in
 * `app/workflows/chat-post-finish.ts`) — a chat id is not attacker-supplied
 * the way a task id from a request body would be, and a task's `chatId` is
 * only ever set to a chat that task itself created (`startTask`), so there is
 * no cross-organization ambiguity to guard against. Scoped to `running`
 * because that is the only status a chat's own turn should ever be able to
 * move on: a chat whose task already finished (`done`/`blocked`/`failed`)
 * must not have a stray later turn re-drive the task board.
 */
export async function getTaskByChatId(
  chatId: string,
): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.chatId, chatId), eq(tasks.status, "running")));
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

  // Guard the write with the status this decision was based on: two
  // concurrent transitions can both read the same `current.status` and both
  // pass `canTransition` above, so without this the second writer would
  // silently clobber the first instead of losing the race visibly. Zero
  // rows back means someone else's write landed first.
  const [row] = await db
    .update(tasks)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.id, taskId),
        eq(tasks.status, current.status),
      ),
    )
    .returning();
  if (!row) {
    throw new TaskTransitionError(
      taskId,
      current.status,
      to,
      `Task "${taskId}" status changed concurrently while transitioning "${current.status}" -> "${to}"`,
    );
  }
  await appendTaskLifecycleEvent(row.chatId, {
    type: "task/status",
    taskId: row.id,
    from: current.status,
    to,
  });
  return row;
}

export type TaskTreeNode = Task & { children: TaskTreeNode[] };

/**
 * Assembles a task and its full subtree, recursing on `parentTaskId`.
 *
 * Organization-scoped at every level, not just the root: a user-supplied
 * task id must never let a caller walk into another organization's subtree,
 * even indirectly through `parentTaskId` links. One query per node rather
 * than a recursive CTE: planner trees are shallow (a goal decomposed into
 * subtasks, not deeply nested), so the simplicity is worth more than the
 * extra round trips.
 */
export async function taskTree(
  organizationId: string,
  rootId: string,
): Promise<TaskTreeNode | undefined> {
  const [root] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.organizationId, organizationId), eq(tasks.id, rootId)));
  if (!root) {
    return;
  }
  return { ...root, children: await childrenOf(organizationId, root.id) };
}

async function childrenOf(
  organizationId: string,
  parentId: string,
): Promise<TaskTreeNode[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, organizationId),
        eq(tasks.parentTaskId, parentId),
      ),
    );
  const nodes: TaskTreeNode[] = [];
  for (const row of rows) {
    nodes.push({ ...row, children: await childrenOf(organizationId, row.id) });
  }
  return nodes;
}
