import { describe, expect, mock, test } from "bun:test";
import { tasks } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type Row = {
  id: string;
  organizationId: string;
  sessionId: string;
  chatId: string | null;
  parentTaskId: string | null;
  title: string;
  goal: string;
  status: string;
  assignedAgent: string | null;
  reviewerRejections: number;
  origin: string;
  resultSummary: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type Predicate = (row: Row) => boolean;

/**
 * Same trick as `roster.test.ts` / `session-events.test.ts`: a tiny in-memory
 * store plus real column objects from the schema, so a mocked `eq`/`and` can
 * filter it the way Drizzle would filter real rows, without standing up a
 * real Postgres.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [tasks.id, "id"],
  [tasks.organizationId, "organizationId"],
  [tasks.sessionId, "sessionId"],
  [tasks.chatId, "chatId"],
  [tasks.parentTaskId, "parentTaskId"],
  [tasks.status, "status"],
]);

function keyFor(column: unknown): keyof Row {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

const actualDrizzle = await import("drizzle-orm");

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  desc: (_column: unknown) => undefined,
}));

let store: Row[] = [];
let nextId = 1;

function makeRow(partial: Partial<Row>): Row {
  const now = new Date();
  return {
    id: partial.id ?? `task-${nextId++}`,
    organizationId: partial.organizationId ?? "org-1",
    sessionId: partial.sessionId ?? "session-1",
    chatId: partial.chatId ?? null,
    parentTaskId: partial.parentTaskId ?? null,
    title: partial.title ?? "Title",
    goal: partial.goal ?? "Goal",
    status: partial.status ?? "todo",
    assignedAgent: partial.assignedAgent ?? null,
    reviewerRejections: partial.reviewerRejections ?? 0,
    origin: partial.origin ?? "user",
    resultSummary: partial.resultSummary ?? null,
    createdBy: partial.createdBy ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

/**
 * A real `Promise` (so `await` without `.orderBy(...)` works) that also
 * carries an `.orderBy` method (so the chained form does too) — `listTasks`
 * calls `.orderBy(...)`, everything else awaits `.where(...)` directly.
 */
function rowsResult(
  rows: Row[],
): Promise<Row[]> & { orderBy: (order: unknown) => Promise<Row[]> } {
  const result = Promise.resolve(rows) as Promise<Row[]> & {
    orderBy: (order: unknown) => Promise<Row[]>;
  };
  result.orderBy = (_order: unknown) => result;
  return result;
}

const fakeDb = {
  select: () => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) =>
        rowsResult(store.filter(predicate).map((row) => ({ ...row }))),
    }),
  }),
  insert: (_table: unknown) => ({
    values: (value: Partial<Row>) => ({
      returning: () => {
        const row = makeRow(value);
        store.push(row);
        return Promise.resolve([{ ...row }]);
      },
    }),
  }),
  update: (_table: unknown) => ({
    set: (patch: Partial<Row>) => ({
      where: (predicate: Predicate) => ({
        returning: () => {
          const updated: Row[] = [];
          for (const row of store) {
            if (predicate(row)) {
              Object.assign(row, patch);
              updated.push({ ...row });
            }
          }
          return Promise.resolve(updated);
        },
      }),
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  TaskTransitionError,
  createTask,
  getTask,
  getTaskByChatId,
  listTasks,
  taskTree,
  transitionTaskStatus,
} = await import("./tasks");

describe("createTask", () => {
  test("creates a todo task with defaults", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Do the thing",
      goal: "Do the whole thing end to end",
    });

    expect(task.status).toBe("todo");
    expect(task.origin).toBe("user");
    expect(task.reviewerRejections).toBe(0);
    expect(task.chatId).toBeNull();
    expect(store).toHaveLength(1);
  });

  test("accepts a parentTaskId for planner trees", async () => {
    store = [];
    const parent = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Parent",
      goal: "Parent goal",
    });
    const child = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Child",
      goal: "Child goal",
      parentTaskId: parent.id,
      origin: "planner",
    });

    expect(child.parentTaskId).toBe(parent.id);
    expect(child.origin).toBe("planner");
  });

  test("creates a task directly in 'blocked' when initialStatus says so", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Org memory proposal",
      goal: "Deploy from main.",
      initialStatus: "blocked",
    });

    expect(task.status).toBe("blocked");
    const reread = await getTask("org-1", task.id);
    expect(reread?.status).toBe("blocked");
  });

  test("rejects an invalid initialStatus without inserting a row", async () => {
    store = [];

    await expect(
      createTask({
        organizationId: "org-1",
        sessionId: "session-1",
        title: "Title",
        goal: "Goal",
        // Bypasses the type system the way an untyped JS caller would —
        // `createTask` must still refuse this at runtime.
        initialStatus: "review" as unknown as "todo" | "blocked",
      }),
    ).rejects.toThrow();
    expect(store).toHaveLength(0);
  });
});

describe("getTask", () => {
  test("is scoped to the organization", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    expect(await getTask("org-1", task.id)).toBeDefined();
    expect(await getTask("org-2", task.id)).toBeUndefined();
  });
});

describe("getTaskByChatId", () => {
  test("finds the running task that owns a chat", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });
    await transitionTaskStatus("org-1", task.id, "running", {
      chatId: "chat-1",
    });

    const found = await getTaskByChatId("chat-1");
    expect(found?.id).toBe(task.id);
    expect(found?.status).toBe("running");
  });

  test("returns undefined for a chat with no running task", async () => {
    store = [];
    expect(await getTaskByChatId("chat-missing")).toBeUndefined();
  });

  test("ignores a chat whose task already finished", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });
    await transitionTaskStatus("org-1", task.id, "running", {
      chatId: "chat-2",
    });
    await transitionTaskStatus("org-1", task.id, "review");
    await transitionTaskStatus("org-1", task.id, "done");

    expect(await getTaskByChatId("chat-2")).toBeUndefined();
  });
});

describe("listTasks", () => {
  test("only returns tasks for the caller's organization", async () => {
    store = [];
    await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "One",
      goal: "One goal",
    });
    await createTask({
      organizationId: "org-2",
      sessionId: "session-2",
      title: "Two",
      goal: "Two goal",
    });

    const orgOne = await listTasks("org-1");
    expect(orgOne).toHaveLength(1);
    expect(orgOne[0]?.title).toBe("One");
  });

  test("filters by status", async () => {
    store = [];
    const a = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "A",
      goal: "A goal",
    });
    await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "B",
      goal: "B goal",
    });
    await transitionTaskStatus("org-1", a.id, "running");

    const running = await listTasks("org-1", { status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]?.title).toBe("A");
  });

  test("filters by sessionId", async () => {
    store = [];
    await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "A",
      goal: "A goal",
    });
    await createTask({
      organizationId: "org-1",
      sessionId: "session-2",
      title: "B",
      goal: "B goal",
    });

    const inSessionOne = await listTasks("org-1", { sessionId: "session-1" });
    expect(inSessionOne).toHaveLength(1);
    expect(inSessionOne[0]?.title).toBe("A");
  });

  test("combines status and sessionId filters", async () => {
    store = [];
    const a = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "A",
      goal: "A goal",
    });
    await createTask({
      organizationId: "org-1",
      sessionId: "session-2",
      title: "B",
      goal: "B goal",
    });
    await transitionTaskStatus("org-1", a.id, "running");

    const result = await listTasks("org-1", {
      status: "running",
      sessionId: "session-1",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("A");
  });
});

describe("transitionTaskStatus", () => {
  test("applies a legal transition", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    const updated = await transitionTaskStatus("org-1", task.id, "running");
    expect(updated.status).toBe("running");
  });

  test("throws TaskTransitionError on an illegal transition, without mutating the row", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    await expect(
      transitionTaskStatus("org-1", task.id, "done"),
    ).rejects.toThrow(TaskTransitionError);

    const reread = await getTask("org-1", task.id);
    expect(reread?.status).toBe("todo");
  });

  test("throws when the task does not exist in the caller's organization", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    await expect(
      transitionTaskStatus("org-2", task.id, "running"),
    ).rejects.toThrow();
  });

  test("accepts an extra patch alongside the status change", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    const updated = await transitionTaskStatus("org-1", task.id, "running", {
      chatId: "chat-1",
    });
    expect(updated.status).toBe("running");
    expect(updated.chatId).toBe("chat-1");
  });

  test("the two Task 8 edges are enforced too: failed -> todo and blocked -> running", async () => {
    store = [];
    const failedTask = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Failed",
      goal: "Goal",
    });
    await transitionTaskStatus("org-1", failedTask.id, "running");
    await transitionTaskStatus("org-1", failedTask.id, "failed");
    const retried = await transitionTaskStatus("org-1", failedTask.id, "todo");
    expect(retried.status).toBe("todo");

    const blockedTask = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Blocked",
      goal: "Goal",
    });
    await transitionTaskStatus("org-1", blockedTask.id, "running");
    await transitionTaskStatus("org-1", blockedTask.id, "blocked");
    const unblocked = await transitionTaskStatus(
      "org-1",
      blockedTask.id,
      "running",
    );
    expect(unblocked.status).toBe("running");
  });

  test("a lost race throws TaskTransitionError and never clobbers the winner's write", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Title",
      goal: "Goal",
    });

    // Both calls read the same "todo" snapshot before either writes — the
    // fake resolves every db call through a microtask, same as a real
    // concurrent pair of requests racing the same row. The loser's UPDATE
    // WHERE clause no longer matches (the winner already flipped the
    // status), so it must throw instead of silently overwriting.
    const [first, second] = await Promise.allSettled([
      transitionTaskStatus("org-1", task.id, "running"),
      transitionTaskStatus("org-1", task.id, "running"),
    ]);

    const settled = [first, second];
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(TaskTransitionError);
    }

    // The loser's write never landed: exactly one row, and it reflects only
    // the winner's transition.
    expect(store).toHaveLength(1);
    const reread = await getTask("org-1", task.id);
    expect(reread?.status).toBe("running");
  });
});

describe("taskTree", () => {
  test("assembles a parent with its children and grandchildren", async () => {
    store = [];
    const root = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Root",
      goal: "Root goal",
    });
    const childA = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Child A",
      goal: "Goal",
      parentTaskId: root.id,
    });
    await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Child B",
      goal: "Goal",
      parentTaskId: root.id,
    });
    await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Grandchild",
      goal: "Goal",
      parentTaskId: childA.id,
    });

    const tree = await taskTree("org-1", root.id);

    expect(tree?.title).toBe("Root");
    expect(tree?.children).toHaveLength(2);
    const foundChildA = tree?.children.find((c) => c.title === "Child A");
    expect(foundChildA?.children).toHaveLength(1);
    expect(foundChildA?.children[0]?.title).toBe("Grandchild");
  });

  test("returns undefined for a task id that does not exist", async () => {
    store = [];
    expect(await taskTree("org-1", "no-such-task")).toBeUndefined();
  });

  test("a leaf task has an empty children array", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Leaf",
      goal: "Goal",
    });

    const tree = await taskTree("org-1", task.id);
    expect(tree?.children).toEqual([]);
  });

  test("is scoped to the organization: another org's task id resolves to nothing", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Someone else's task",
      goal: "Goal",
    });

    expect(await taskTree("org-2", task.id)).toBeUndefined();
  });

  test("is scoped to the organization: a child from another org is excluded from the tree", async () => {
    store = [];
    const root = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Root",
      goal: "Root goal",
    });
    // Not a realistic row (parentTaskId would normally be same-org), but it
    // proves the child fetch itself is org-filtered, not just the root.
    await createTask({
      organizationId: "org-2",
      sessionId: "session-2",
      title: "Cross-org child",
      goal: "Goal",
      parentTaskId: root.id,
    });

    const tree = await taskTree("org-1", root.id);
    expect(tree?.children).toEqual([]);
  });
});
