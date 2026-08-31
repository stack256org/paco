import { beforeEach, describe, expect, mock, test } from "bun:test";

// Every dependency `actions.ts` imports is mocked here, at the module level —
// none of them do their own database work in this test. `@/lib/db/tasks` (a
// real module exercised for real by `lib/db/tasks.test.ts`) is never itself
// mocked in-place, only its call sites' *dependencies* are.
mock.module("server-only", () => ({}));

const organization = { id: "org-1" };
mock.module("@/lib/org/organization", () => ({
  getOrganization: () => Promise.resolve(organization),
}));

type FakeSession = {
  id: string;
  title: string;
  status: string;
};
let sessionsById = new Map<string, FakeSession>();
mock.module("@/lib/db/sessions", () => ({
  getSessionById: (id: string) => Promise.resolve(sessionsById.get(id)),
  getSessions: () => Promise.resolve([...sessionsById.values()]),
}));

let roster: Record<string, unknown> = { executor: {}, explorer: {} };
mock.module("@/lib/db/roster", () => ({
  getRoster: () => Promise.resolve(roster),
}));

/**
 * `TaskTransitionError` has to be the exact class `actions.ts`'s
 * `instanceof` checks compare against — it imports the class from this same
 * mocked module, not the real `lib/db/tasks.ts`, so re-declaring it here
 * (rather than importing the real one) is what keeps the mock self
 * contained.
 */
class MockTaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockTaskTransitionError";
  }
}

type FakeTask = {
  id: string;
  organizationId: string;
  /** Null for a proposal/reflection task that belongs to no session yet. */
  sessionId: string | null;
  parentTaskId: string | null;
  title: string;
  goal: string;
  status: string;
  assignedAgent: string | null;
  origin: string;
  reviewerRejections: number;
  chatId: string | null;
  resultSummary: string | null;
};

let tasksStore: FakeTask[] = [];
let createTaskCalls: Array<Record<string, unknown>> = [];
let transitionCalls: Array<{
  organizationId: string;
  taskId: string;
  to: string;
  patch?: Record<string, unknown>;
}> = [];
/** Legal edges only — enough of the real state machine for these tests. */
const LEGAL: Record<string, string[]> = {
  todo: ["running"],
  running: ["review", "blocked", "failed"],
  review: ["done", "running", "blocked", "failed"],
  blocked: ["running", "todo"],
  failed: ["todo"],
  done: [],
};

mock.module("@/lib/db/tasks", () => ({
  TaskTransitionError: MockTaskTransitionError,
  createTask: (input: Record<string, unknown>) => {
    createTaskCalls.push(input);
    const row: FakeTask = {
      id: `task-${tasksStore.length + 1}`,
      organizationId: input.organizationId as string,
      sessionId: input.sessionId as string | null,
      parentTaskId: (input.parentTaskId as string | null) ?? null,
      title: input.title as string,
      goal: input.goal as string,
      status: (input.initialStatus as string) ?? "todo",
      assignedAgent: (input.assignedAgent as string | null) ?? null,
      origin: (input.origin as string) ?? "user",
      reviewerRejections: 0,
      chatId: null,
      resultSummary: null,
    };
    tasksStore.push(row);
    return Promise.resolve(row);
  },
  getTask: (organizationId: string, taskId: string) =>
    Promise.resolve(
      tasksStore.find(
        (task) => task.id === taskId && task.organizationId === organizationId,
      ),
    ),
  listTasks: (organizationId: string) =>
    Promise.resolve(
      tasksStore.filter((task) => task.organizationId === organizationId),
    ),
  taskTree: (organizationId: string, rootId: string) => {
    const build = (id: string): unknown => {
      const row = tasksStore.find(
        (task) => task.id === id && task.organizationId === organizationId,
      );
      if (!row) {
        return;
      }
      return {
        ...row,
        children: tasksStore
          .filter(
            (task) =>
              task.parentTaskId === id &&
              task.organizationId === organizationId,
          )
          .map((child) => build(child.id)),
      };
    };
    return Promise.resolve(build(rootId));
  },
  transitionTaskStatus: (
    organizationId: string,
    taskId: string,
    to: string,
    patch?: Record<string, unknown>,
  ) => {
    transitionCalls.push({ organizationId, taskId, to, patch });
    const task = tasksStore.find(
      (candidate) =>
        candidate.id === taskId && candidate.organizationId === organizationId,
    );
    if (!task) {
      return Promise.reject(new Error(`No task "${taskId}"`));
    }
    if (!LEGAL[task.status]?.includes(to)) {
      return Promise.reject(
        new MockTaskTransitionError(
          `Task "${taskId}" cannot transition from "${task.status}" to "${to}"`,
        ),
      );
    }
    Object.assign(task, patch, { status: to });
    return Promise.resolve({ ...task });
  },
}));

let planGoalResult:
  | { ok: true; rootTaskId: string; taskIds: string[] }
  | {
      ok: false;
      error: string;
    } = { ok: true, rootTaskId: "root-1", taskIds: ["child-1"] };
let planGoalCalls: Array<Record<string, unknown>> = [];
mock.module("@/lib/tasks/planner", () => ({
  planGoal: (params: Record<string, unknown>) => {
    planGoalCalls.push(params);
    return Promise.resolve(planGoalResult);
  },
}));

let startTaskResult:
  | { ok: true; chatId: string }
  | { ok: false; error: string } = { ok: true, chatId: "chat-1" };
let startTaskCalls: Array<{ organizationId: string; taskId: string }> = [];
/** Per-task overrides, for a plan where only some subtasks start. */
let startTaskResultByTaskId = new Map<
  string,
  { ok: true; chatId: string } | { ok: false; error: string }
>();
mock.module("@/lib/tasks/start", () => ({
  startTask: (organizationId: string, taskId: string) => {
    startTaskCalls.push({ organizationId, taskId });
    return Promise.resolve(
      startTaskResultByTaskId.get(taskId) ?? startTaskResult,
    );
  },
}));

let kickExecutorFixTurnResult: Promise<void> | Error = Promise.resolve();
let kickExecutorFixTurnCalls: Array<Record<string, unknown>> = [];
const kickExecutorFixTurnSpy = mock((params: Record<string, unknown>) => {
  kickExecutorFixTurnCalls.push(params);
  if (kickExecutorFixTurnResult instanceof Error) {
    return Promise.reject(kickExecutorFixTurnResult);
  }
  return kickExecutorFixTurnResult;
});
mock.module("@/lib/tasks/reviewer-gate", () => ({
  kickExecutorFixTurn: kickExecutorFixTurnSpy,
}));

const {
  createTaskAction,
  listEnabledAgentNamesAction,
  listMySessionsForTaskAction,
  listOrgTasksAction,
  retryTaskAction,
  startSubtasksAction,
  startTaskAction,
  unblockTaskAction,
} = await import("./actions");

beforeEach(() => {
  roster = { executor: {}, explorer: {} };
  sessionsById = new Map([
    [
      "session-1",
      {
        id: "session-1",
        title: "My session",
        status: "active",
      },
    ],
    [
      "session-2",
      {
        id: "session-2",
        title: "Someone else's session",
        status: "active",
      },
    ],
  ]);
  tasksStore = [];
  createTaskCalls = [];
  transitionCalls = [];
  planGoalCalls = [];
  planGoalResult = { ok: true, rootTaskId: "root-1", taskIds: ["child-1"] };
  startTaskCalls = [];
  startTaskResult = { ok: true, chatId: "chat-1" };
  startTaskResultByTaskId = new Map();
  kickExecutorFixTurnCalls = [];
  kickExecutorFixTurnResult = Promise.resolve();
});

describe("listOrgTasksAction", () => {
  test("scopes to the caller's organisation only", async () => {
    tasksStore = [
      {
        id: "task-mine",
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: null,
        title: "Mine",
        goal: "goal",
        status: "todo",
        assignedAgent: null,
        origin: "user",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: null,
      },
      {
        id: "task-other-org",
        organizationId: "org-2",
        sessionId: "session-2",
        parentTaskId: null,
        title: "Not mine",
        goal: "goal",
        status: "todo",
        assignedAgent: null,
        origin: "user",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: null,
      },
    ];

    const rows = await listOrgTasksAction();

    expect(rows.map((row) => row.id)).toEqual(["task-mine"]);
    expect(rows[0]?.sessionTitle).toBe("My session");
  });

  test("marks a task with children as not a leaf", async () => {
    tasksStore = [
      {
        id: "root",
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: null,
        title: "Root",
        goal: "goal",
        status: "todo",
        assignedAgent: null,
        origin: "planner",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: null,
      },
      {
        id: "child",
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: "root",
        title: "Child",
        goal: "goal",
        status: "todo",
        assignedAgent: null,
        origin: "planner",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: null,
      },
    ];

    const rows = await listOrgTasksAction();
    const root = rows.find((row) => row.id === "root");
    const child = rows.find((row) => row.id === "child");

    expect(root?.isLeaf).toBe(false);
    expect(child?.isLeaf).toBe(true);
  });
});

describe("listMySessionsForTaskAction / listEnabledAgentNamesAction", () => {
  test("every non-archived session comes back, across the whole instance", async () => {
    sessionsById.set("session-3", {
      id: "session-3",
      title: "Archived",
      status: "archived",
    });

    const rows = await listMySessionsForTaskAction();

    expect(rows).toEqual([
      { id: "session-1", title: "My session" },
      { id: "session-2", title: "Someone else's session" },
    ]);
  });

  test("lists enabled roster names, sorted", async () => {
    roster = { zeta: {}, alpha: {} };
    const names = await listEnabledAgentNamesAction();
    expect(names).toEqual(["alpha", "zeta"]);
  });
});

describe("createTaskAction", () => {
  test("creates a task directly against an existing session", async () => {
    const result = await createTaskAction({
      title: "Ship it",
      goal: "Ship the feature",
      sessionId: "session-1",
    });

    expect(result).toEqual({ ok: true, taskId: "task-1" });
    expect(createTaskCalls).toHaveLength(1);
    expect(createTaskCalls[0]).toMatchObject({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Ship it",
      goal: "Ship the feature",
    });
    expect(planGoalCalls).toHaveLength(0);
  });

  test("refuses an assignedAgent that is not in the enabled roster", async () => {
    const result = await createTaskAction({
      title: "Ship it",
      goal: "Ship the feature",
      sessionId: "session-1",
      assignedAgent: "not-a-real-agent",
    });

    expect(result.ok).toBe(false);
    expect(createTaskCalls).toHaveLength(0);
  });

  test("the plan-this-goal toggle routes to the planner instead of createTask", async () => {
    const result = await createTaskAction({
      title: "ignored for plans",
      goal: "Build the whole feature",
      sessionId: "session-1",
      planThisGoal: true,
    });

    expect(result).toEqual({ ok: true, taskId: "root-1" });
    expect(planGoalCalls).toHaveLength(1);
    expect(planGoalCalls[0]).toMatchObject({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Build the whole feature",
    });
    expect(createTaskCalls).toHaveLength(0);
  });

  test("surfaces a planner failure as a value, not a throw", async () => {
    planGoalResult = { ok: false, error: "Planner returned zero tasks" };

    const result = await createTaskAction({
      title: "x",
      goal: "Build the whole feature",
      sessionId: "session-1",
      planThisGoal: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "Planner returned zero tasks",
    });
  });
});

describe("startTaskAction", () => {
  test("delegates to startTask, scoped by the caller's org", async () => {
    const result = await startTaskAction("task-1");

    expect(result).toEqual({ ok: true, chatId: "chat-1" });
    expect(startTaskCalls).toEqual([
      { organizationId: "org-1", taskId: "task-1" },
    ]);
  });

  test("surfaces a startTask failure as a value, not a throw", async () => {
    startTaskResult = { ok: false, error: "task has children" };

    const result = await startTaskAction("task-1");

    expect(result).toEqual({ ok: false, error: "task has children" });
  });
});

describe("retryTaskAction", () => {
  test("failed -> todo succeeds", async () => {
    tasksStore = [
      {
        id: "task-1",
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: null,
        title: "t",
        goal: "g",
        status: "failed",
        assignedAgent: null,
        origin: "user",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: "boom",
      },
    ];

    const result = await retryTaskAction("task-1");

    expect(result).toEqual({ ok: true });
    expect(tasksStore[0]?.status).toBe("todo");
  });

  test("an illegal edge (e.g. todo -> todo) is surfaced as an error value, not thrown", async () => {
    tasksStore = [
      {
        id: "task-1",
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: null,
        title: "t",
        goal: "g",
        status: "todo",
        assignedAgent: null,
        origin: "user",
        reviewerRejections: 0,
        chatId: null,
        resultSummary: null,
      },
    ];

    const result = await retryTaskAction("task-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot transition");
    }
  });
});

describe("unblockTaskAction", () => {
  function blockedTask(overrides: Partial<FakeTask> = {}): FakeTask {
    return {
      id: "task-1",
      organizationId: "org-1",
      sessionId: "session-1",
      parentTaskId: null,
      title: "t",
      goal: "g",
      status: "blocked",
      assignedAgent: null,
      origin: "user",
      reviewerRejections: 2,
      chatId: "chat-1",
      resultSummary: "blocked: too many rejections",
      ...overrides,
    };
  }

  test("blocked -> running resets reviewerRejections and re-kicks the executor", async () => {
    tasksStore = [blockedTask()];

    const result = await unblockTaskAction("task-1");

    expect(result).toEqual({ ok: true, chatId: "chat-1" });
    expect(tasksStore[0]?.status).toBe("running");
    expect(tasksStore[0]?.reviewerRejections).toBe(0);
    expect(kickExecutorFixTurnCalls).toHaveLength(1);
    expect(kickExecutorFixTurnCalls[0]).toMatchObject({
      sessionId: "session-1",
      chatId: "chat-1",
    });
  });

  test("a session that cannot be loaded leaves the task blocked, not running", async () => {
    tasksStore = [blockedTask()];
    sessionsById = new Map();

    const result = await unblockTaskAction("task-1");

    expect(result.ok).toBe(false);
    // The whole point: validation happens before the write, so a task whose
    // unblock could never have succeeded is still where a human left it —
    // not stranded in `running`, a status the board offers no action for.
    expect(tasksStore[0]?.status).toBe("blocked");
    expect(transitionCalls).toHaveLength(0);
    expect(kickExecutorFixTurnCalls).toHaveLength(0);
  });

  test("a re-kick failure moves the task to failed, not left running", async () => {
    tasksStore = [blockedTask()];
    kickExecutorFixTurnResult = new Error("workflow start failed");

    const result = await unblockTaskAction("task-1");

    expect(result).toEqual({ ok: false, error: "workflow start failed" });
    expect(tasksStore[0]?.status).toBe("failed");
  });

  test("a task that is not blocked is surfaced, not thrown", async () => {
    tasksStore = [blockedTask({ status: "done" })];

    const result = await unblockTaskAction("task-1");

    expect(result.ok).toBe(false);
    expect(tasksStore[0]?.status).toBe("done");
    expect(transitionCalls).toHaveLength(0);
    expect(kickExecutorFixTurnCalls).toHaveLength(0);
  });

  test("a blocked task with no chat is released to todo and started fresh", async () => {
    tasksStore = [blockedTask({ chatId: null, reviewerRejections: 0 })];

    const result = await unblockTaskAction("task-1");

    expect(result).toEqual({ ok: true, chatId: "chat-1" });
    expect(transitionCalls).toEqual([
      {
        organizationId: "org-1",
        taskId: "task-1",
        to: "todo",
        patch: { sessionId: "session-1", reviewerRejections: 0 },
      },
    ]);
    expect(startTaskCalls).toEqual([
      { organizationId: "org-1", taskId: "task-1" },
    ]);
    // There is no chat to resume — starting one is the unblock.
    expect(kickExecutorFixTurnCalls).toHaveLength(0);
  });

  test("a proposal task with no session is unblocked onto the session the caller picks", async () => {
    tasksStore = [
      blockedTask({ chatId: null, sessionId: null, reviewerRejections: 0 }),
    ];

    const result = await unblockTaskAction("task-1", {
      sessionId: "session-1",
    });

    expect(result).toEqual({ ok: true, chatId: "chat-1" });
    expect(transitionCalls[0]?.patch).toMatchObject({
      sessionId: "session-1",
    });
    expect(tasksStore[0]?.sessionId).toBe("session-1");
    expect(startTaskCalls).toHaveLength(1);
  });

  test("a proposal task with no session and no session picked stays blocked", async () => {
    tasksStore = [
      blockedTask({ chatId: null, sessionId: null, reviewerRejections: 0 }),
    ];

    const result = await unblockTaskAction("task-1");

    expect(result.ok).toBe(false);
    expect(tasksStore[0]?.status).toBe("blocked");
    expect(transitionCalls).toHaveLength(0);
    expect(startTaskCalls).toHaveLength(0);
  });

  test("a failure to start the fresh chat leaves the task in todo, where Start is offered", async () => {
    tasksStore = [blockedTask({ chatId: null, reviewerRejections: 0 })];
    startTaskResult = { ok: false, error: "no sandbox" };

    const result = await unblockTaskAction("task-1");

    expect(result).toEqual({ ok: false, error: "no sandbox" });
    expect(tasksStore[0]?.status).toBe("todo");
  });
});

describe("startSubtasksAction", () => {
  function plan(): FakeTask[] {
    const base = {
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "g",
      assignedAgent: null,
      origin: "planner",
      reviewerRejections: 0,
      chatId: null,
      resultSummary: null,
    };
    return [
      {
        ...base,
        id: "root-1",
        parentTaskId: null,
        title: "The plan",
        status: "todo",
      },
      {
        ...base,
        id: "child-1",
        parentTaskId: "root-1",
        title: "First",
        status: "todo",
      },
      {
        ...base,
        id: "child-2",
        parentTaskId: "root-1",
        title: "Second",
        status: "todo",
      },
    ];
  }

  test("starts every todo leaf under a grouping node, and not the node itself", async () => {
    tasksStore = plan();

    const result = await startSubtasksAction("root-1");

    expect(result).toEqual({ ok: true, started: 2 });
    expect(startTaskCalls).toEqual([
      { organizationId: "org-1", taskId: "child-1" },
      { organizationId: "org-1", taskId: "child-2" },
    ]);
  });

  test("skips subtasks that are no longer todo", async () => {
    tasksStore = plan();
    const child = tasksStore[1];
    if (child) {
      child.status = "done";
    }

    const result = await startSubtasksAction("root-1");

    expect(result).toEqual({ ok: true, started: 1 });
    expect(startTaskCalls).toEqual([
      { organizationId: "org-1", taskId: "child-2" },
    ]);
  });

  test("one subtask failing to start does not fail the whole plan", async () => {
    tasksStore = plan();
    startTaskResultByTaskId.set("child-1", { ok: false, error: "no sandbox" });

    const result = await startSubtasksAction("root-1");

    expect(result).toEqual({ ok: true, started: 1 });
  });

  test("surfaces the first error when nothing could be started", async () => {
    tasksStore = plan();
    startTaskResult = { ok: false, error: "no sandbox" };

    const result = await startSubtasksAction("root-1");

    expect(result).toEqual({ ok: false, error: "no sandbox" });
  });

  test("a leaf task is directed to Start instead", async () => {
    tasksStore = [plan()[1] as FakeTask];

    const result = await startSubtasksAction("child-1");

    expect(result.ok).toBe(false);
    expect(startTaskCalls).toHaveLength(0);
  });

  test("a plan whose subtasks have all been started already says so", async () => {
    tasksStore = plan();
    for (const task of tasksStore.slice(1)) {
      task.status = "running";
    }

    const result = await startSubtasksAction("root-1");

    expect(result.ok).toBe(false);
    expect(startTaskCalls).toHaveLength(0);
  });
});
