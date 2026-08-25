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

    const tree = await taskTree(root.id);

    expect(tree?.title).toBe("Root");
    expect(tree?.children).toHaveLength(2);
    const foundChildA = tree?.children.find((c) => c.title === "Child A");
    expect(foundChildA?.children).toHaveLength(1);
    expect(foundChildA?.children[0]?.title).toBe("Grandchild");
  });

  test("returns undefined for a task id that does not exist", async () => {
    store = [];
    expect(await taskTree("no-such-task")).toBeUndefined();
  });

  test("a leaf task has an empty children array", async () => {
    store = [];
    const task = await createTask({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Leaf",
      goal: "Goal",
    });

    const tree = await taskTree(task.id);
    expect(tree?.children).toEqual([]);
  });
});
