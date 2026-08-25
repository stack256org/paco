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
 * Why a transition was refused. These are opposite situations that happen to
 * share an exception type, and a caller that cannot tell them apart cannot
 * respond correctly to either:
 *
 * - `"illegal"` — `from -> to` is not an edge of the state machine
 *   (`lib/tasks/state.ts`). Nobody raced anybody; the code asking for this
 *   transition is wrong about the machine. It must be loud.
 * - `"race"` — the edge was legal, but another writer moved the task first
 *   and this write's guarded `WHERE` no longer matched. Nothing is wrong;
 *   the other writer's outcome stands.
 *
 * Collapsing the two is not academic: the reviewer gate logged both as "a
 * race" and returned as if it had blocked the task, which is how a missing
 * `review -> blocked` edge survived an entire branch without a single loud
 * failure.
 */
export type TaskTransitionErrorKind = "illegal" | "race";

/**
 * Thrown by `transitionTaskStatus` when a transition is refused — see
 * `kind` for which of the two refusals it is.
 *
 * Naming the failure makes the state-machine invariant visible at call
 * sites and in logs, rather than looking like any other database failure —
 * the same reasoning `PluginGrantEscalationError` uses for the plugin grant
 * invariant.
 */
export class TaskTransitionError extends Error {
  readonly kind: TaskTransitionErrorKind;

  constructor(
    kind: TaskTransitionErrorKind,
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    reason?: string,
  ) {
    super(
      reason ?? `Task "${taskId}" cannot transition from "${from}" to "${to}"`,
    );
    this.name = "TaskTransitionError";
    this.kind = kind;
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
  // No `task/created` event here, deliberately: `task/created` is a CHAT
  // log entry, and a task has no chat at creation — `CreateTaskInput` has
  // no `chatId` field and a proposal task may never get one at all. Emitting
  // it here was a call that could never fire, which is why nothing could
  // ever observe a task being created. It is emitted from
  // `transitionTaskStatus` instead, the moment a chat is first attached.
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

/**
 * Extra columns a status transition may set alongside the new status.
 *
 * `sessionId` is here for one case: a proposal task
 * (`lib/memory/reflect.ts`, `lib/memory/promote.ts`) is created `blocked`
 * with no session at all, and the human who unblocks it is the first person
 * to say which repository the work belongs in. That choice arrives with the
 * `blocked -> todo` transition and is written in the same guarded update
 * rather than through a second, unchecked write — see `unblockTaskAction`
 * (`app/tasks/actions.ts`).
 */
export type TaskTransitionPatch = Partial<
  Pick<
    Task,
    | "chatId"
    | "sessionId"
    | "reviewerRejections"
    | "resultSummary"
    | "assignedAgent"
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
 *
 * Also where a task's `task/created` event fires — see the guard below for
 * why it cannot fire at creation time.
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
    throw new TaskTransitionError("illegal", taskId, current.status, to);
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
      "race",
      taskId,
      current.status,
      to,
      `Task "${taskId}" status changed concurrently while transitioning "${current.status}" -> "${to}"`,
    );
  }
  // The first transition to attach a chat is the first moment this task has
  // a log to be recorded in at all, so its creation event leads that log
  // here rather than at `createTask` (where there was no chat, and the event
  // therefore never fired). Guarded on the chat being NEW to the task so a
  // later transition cannot re-announce a task the chat already knows.
  if (!current.chatId && row.chatId) {
    await appendTaskLifecycleEvent(row.chatId, {
      type: "task/created",
      taskId: row.id,
      title: row.title,
      origin: row.origin,
    });
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
