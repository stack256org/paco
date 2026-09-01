import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Task } from "@/lib/db/schema";
import type { TaskTreeNode } from "@/lib/db/tasks";

mock.module("server-only", () => ({}));
mock.module("ai", () => ({
  generateId: () => "generated-id",
}));
mock.module("nanoid", () => ({
  nanoid: () => "new-chat-id",
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    organizationId: "org-1",
    sessionId: "session-1",
    chatId: null,
    parentTaskId: null,
    title: "Add tests for the widget",
    goal: "Add tests for the widget",
    status: "todo",
    assignedAgent: null,
    reviewerRejections: 0,
    origin: "user",
    resultSummary: null,
    createdAt: new Date("2026-08-25T00:00:00Z"),
    updatedAt: new Date("2026-08-25T00:00:00Z"),
    ...overrides,
  };
}

function makeNode(overrides: Partial<Task> = {}): TaskTreeNode {
  return { ...makeTask(overrides), children: [] };
}

// ── `@/lib/db/tasks` ─────────────────────────────────────────────

/**
 * Mirrors the real `TaskTransitionError` closely enough for `instanceof`
 * checks in `start.ts` to see the same class this mock module exports —
 * `start.ts` imports `TaskTransitionError` from `@/lib/db/tasks`, which this
 * `mock.module` call replaces entirely, so the real class is never in scope
 * to check against.
 */
class TaskTransitionErrorMockError extends Error {
  constructor(taskId: string, from: string, to: string) {
    super(`Task "${taskId}" cannot transition from "${from}" to "${to}"`);
    this.name = "TaskTransitionErrorMockError";
  }
}

let taskTreeNode: TaskTreeNode | undefined;
let parentTask: Task | undefined;
/** When set, the `running` transition throws this instead of succeeding. */
let transitionRunningError: Error | undefined;

const taskTreeMock = mock(
  async (_organizationId: string, _taskId: string) => taskTreeNode,
);
const getTaskMock = mock(
  async (_organizationId: string, _taskId: string) => parentTask,
);
const transitionTaskStatusMock = mock(
  async (
    _organizationId: string,
    _taskId: string,
    to: string,
    _patch?: Record<string, unknown>,
  ) => {
    if (to === "running" && transitionRunningError) {
      throw transitionRunningError;
    }
    return makeTask();
  },
);

mock.module("@/lib/db/tasks", () => ({
  TaskTransitionError: TaskTransitionErrorMockError,
  taskTree: taskTreeMock,
  getTask: getTaskMock,
  transitionTaskStatus: transitionTaskStatusMock,
}));

// ── `@/lib/db/sessions` ──────────────────────────────────────────

let sessionRow: { status: string } | undefined = {
  status: "running",
};

const getSessionByIdMock = mock(async (_sessionId: string) => sessionRow);
const createChatMock = mock(
  async (input: {
    id: string;
    sessionId: string;
    title: string;
    modelId?: string | null;
  }) => ({
    id: input.id,
    sessionId: input.sessionId,
    title: input.title,
    modelId: input.modelId ?? null,
    activeStreamId: null as string | null,
  }),
);
const deleteChatMock = mock(async (_chatId: string) => undefined);

mock.module("@/lib/db/sessions", () => ({
  getSessionById: getSessionByIdMock,
  createChat: createChatMock,
  deleteChat: deleteChatMock,
}));

// ── `@/lib/db/user-preferences` ──────────────────────────────────

const getUserPreferencesMock = mock(async (_userId: string) => ({
  defaultModelId: "opus",
}));
/*
 * `startTask` reads the LIVE roster so a task naming a since-disabled agent
 * degrades instead of instructing the executor to delegate to a subagent
 * that no longer exists. Mocked here because the real module reaches the
 * database; the two defaults are what `DEFAULT_ROSTER` seeds.
 */
let rosterAgents: Record<string, unknown> = {
  explorer: { description: "explorer", prompt: "", tools: [] },
  executor: { description: "executor", prompt: "", tools: [] },
};
mock.module("@/lib/db/roster", () => ({
  getRoster: () => Promise.resolve(rosterAgents),
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: getUserPreferencesMock,
}));

// ── `@/lib/chat/submit-message` ───────────────────────────────────

type SubmitOutcome =
  | { kind: "archived" }
  | { kind: "buffer-failed" }
  | { kind: "conflict" }
  | { kind: "streaming"; runId: string; stream: unknown };

let submitOutcome: SubmitOutcome = {
  kind: "streaming",
  runId: "run-1",
  stream: null,
};
let submitImpl: (
  input: Record<string, unknown>,
) => Promise<SubmitOutcome> = async () => submitOutcome;
const submitChatMessageMock = mock((input: Record<string, unknown>) =>
  submitImpl(input),
);

mock.module("@/lib/chat/submit-message", () => ({
  submitChatMessage: submitChatMessageMock,
}));

const { buildTaskPrompt, startTask, TASK_DEFAULT_MAX_TURNS } =
  await import("./start");

beforeEach(() => {
  taskTreeNode = makeNode();
  parentTask = undefined;
  transitionRunningError = undefined;
  sessionRow = { status: "running" };
  submitOutcome = { kind: "streaming", runId: "run-1", stream: null };
  submitImpl = async () => submitOutcome;

  taskTreeMock.mockClear();
  getTaskMock.mockClear();
  transitionTaskStatusMock.mockClear();
  getSessionByIdMock.mockClear();
  createChatMock.mockClear();
  deleteChatMock.mockClear();
  getUserPreferencesMock.mockClear();
  submitChatMessageMock.mockClear();
});

// ── buildTaskPrompt ───────────────────────────────────────────────

describe("buildTaskPrompt", () => {
  test("renders just the goal when there is no parent or assigned agent", () => {
    const task = makeTask({ goal: "Add tests for the widget" });

    expect(buildTaskPrompt(task)).toBe("Add tests for the widget");
  });

  test("adds a parent-context line when a parent task is passed", () => {
    const task = makeTask({
      goal: "Add tests for the widget",
      parentTaskId: "task-parent",
    });
    const parent = makeTask({
      id: "task-parent",
      title: "Ship the widget",
      goal: "Build and ship the customer widget end-to-end",
    });

    expect(buildTaskPrompt(task, parent)).toBe(
      'Add tests for the widget\n\nParent task: "Ship the widget" — Build and ship the customer widget end-to-end',
    );
  });

  test("adds a delegation line when assignedAgent is set", () => {
    const task = makeTask({
      goal: "Add tests for the widget",
      assignedAgent: "qa-reviewer",
    });

    expect(buildTaskPrompt(task)).toBe(
      'Add tests for the widget\n\nDelegate this work to the "qa-reviewer" subagent.',
    );
  });

  test("drops the delegation line when the named agent is no longer on the roster", () => {
    // `assignedAgent` is validated on save, but disabling or renaming a
    // roster entry afterwards never revisits the tasks and schedules that
    // already name it — a schedule keeps firing forever with a stale name.
    // Instructing the executor to delegate to a subagent that does not exist
    // is an instruction it can neither follow nor diagnose.
    const task = makeTask({
      goal: "Add tests for the widget",
      assignedAgent: "retired-agent",
    });

    expect(buildTaskPrompt(task, null, new Set(["explorer", "executor"]))).toBe(
      "Add tests for the widget",
    );
  });

  test("keeps the delegation line when the named agent is on the roster", () => {
    const task = makeTask({
      goal: "Add tests for the widget",
      assignedAgent: "qa-reviewer",
    });

    expect(
      buildTaskPrompt(task, null, new Set(["executor", "qa-reviewer"])),
    ).toBe(
      'Add tests for the widget\n\nDelegate this work to the "qa-reviewer" subagent.',
    );
  });

  test("an empty roster drops the line rather than trusting the stored name", () => {
    const task = makeTask({
      goal: "Add tests for the widget",
      assignedAgent: "qa-reviewer",
    });

    expect(buildTaskPrompt(task, null, new Set())).toBe(
      "Add tests for the widget",
    );
  });

  test("renders all three sections together", () => {
    const task = makeTask({
      goal: "Add tests for the widget",
      parentTaskId: "task-parent",
      assignedAgent: "qa-reviewer",
    });
    const parent = makeTask({
      id: "task-parent",
      title: "Ship the widget",
      goal: "Build and ship the customer widget end-to-end",
    });

    expect(buildTaskPrompt(task, parent)).toBe(
      'Add tests for the widget\n\nParent task: "Ship the widget" — Build and ship the customer widget end-to-end\n\nDelegate this work to the "qa-reviewer" subagent.',
    );
  });
});

// ── startTask ─────────────────────────────────────────────────────

describe("startTask", () => {
  test("fails when the task does not exist", async () => {
    taskTreeNode = undefined;

    const result = await startTask("org-1", "missing-task");

    expect(result).toEqual({
      ok: false,
      error: 'Task "missing-task" not found',
    });
    expect(createChatMock).not.toHaveBeenCalled();
  });

  test("refuses to start a task that has children", async () => {
    taskTreeNode = { ...makeTask(), children: [makeNode({ id: "child-1" })] };

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({
      ok: false,
      error: 'Task "task-1" has children and cannot be started directly',
    });
    expect(createChatMock).not.toHaveBeenCalled();
    expect(transitionTaskStatusMock).not.toHaveBeenCalled();
  });

  test("refuses to start a task that is not todo", async () => {
    taskTreeNode = makeNode({ status: "running" });

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({
      ok: false,
      error: 'Task "task-1" is not "todo" (currently "running")',
    });
    expect(createChatMock).not.toHaveBeenCalled();
  });

  test("fails when the task's session no longer exists", async () => {
    sessionRow = undefined;

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({
      ok: false,
      error: 'Session "session-1" not found',
    });
    expect(createChatMock).not.toHaveBeenCalled();
  });

  test("refuses to start a session-less task", async () => {
    taskTreeNode = makeNode({ sessionId: null });

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({
      ok: false,
      error: 'Task "task-1" has no session and cannot be started',
    });
    expect(createChatMock).not.toHaveBeenCalled();
  });

  test("creates the chat, transitions to running, and submits through the shared message path", async () => {
    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({ ok: true, chatId: "new-chat-id" });

    expect(createChatMock).toHaveBeenCalledWith({
      id: "new-chat-id",
      sessionId: "session-1",
      title: "Add tests for the widget",
      modelId: "opus",
    });

    expect(transitionTaskStatusMock).toHaveBeenNthCalledWith(
      1,
      "org-1",
      "task-1",
      "running",
      { chatId: "new-chat-id" },
    );

    expect(submitChatMessageMock).toHaveBeenCalledTimes(1);
    const input = submitChatMessageMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(input.chatId).toBe("new-chat-id");
    expect(input.sessionId).toBe("session-1");
    expect(input.sessionStatus).toBe("running");
    expect(input.activeStreamId).toBeNull();
    expect(input.maxSteps).toBe(TASK_DEFAULT_MAX_TURNS);
    const messages = input.messages as Array<{
      role: string;
      parts: Array<{ type: string; text: string }>;
    }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Add tests for the widget" },
    ]);

    expect(deleteChatMock).not.toHaveBeenCalled();
  });

  test("builds the prompt from the parent task and the assigned agent", async () => {
    rosterAgents = {
      ...rosterAgents,
      "qa-reviewer": { description: "qa", prompt: "", tools: [] },
    };
    taskTreeNode = makeNode({
      parentTaskId: "task-parent",
      assignedAgent: "qa-reviewer",
    });
    parentTask = makeTask({
      id: "task-parent",
      title: "Ship the widget",
      goal: "Build and ship the customer widget end-to-end",
    });

    await startTask("org-1", "task-1");

    expect(getTaskMock).toHaveBeenCalledWith("org-1", "task-parent");
    const input = submitChatMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(input.messages[0]?.parts[0]?.text).toBe(
      'Add tests for the widget\n\nParent task: "Ship the widget" — Build and ship the customer widget end-to-end\n\nDelegate this work to the "qa-reviewer" subagent.',
    );
  });

  test("drops a delegation to an agent the roster no longer has", async () => {
    // The end-to-end half of the buildTaskPrompt case: a schedule created
    // when "qa-reviewer" existed keeps firing after the roster entry is
    // disabled, and `assignedAgent` is only validated on save. The turn must
    // not be told to delegate to something that cannot be resolved.
    rosterAgents = {
      explorer: { description: "explorer", prompt: "", tools: [] },
      executor: { description: "executor", prompt: "", tools: [] },
    };
    taskTreeNode = makeNode({ assignedAgent: "qa-reviewer" });

    await startTask("org-1", "task-1");

    const input = submitChatMessageMock.mock.calls[0]?.[0] as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(input.messages[0]?.parts[0]?.text).toBe("Add tests for the widget");
    expect(input.messages[0]?.parts[0]?.text).not.toContain("qa-reviewer");
  });

  test("passes opts.maxTurns through as maxSteps", async () => {
    await startTask("org-1", "task-1", { maxTurns: 10 });

    const input = submitChatMessageMock.mock.calls[0]?.[0] as {
      maxSteps?: number;
    };
    expect(input.maxSteps).toBe(10);
  });

  test("defaults opts.maxTurns to TASK_DEFAULT_MAX_TURNS when omitted", async () => {
    expect(TASK_DEFAULT_MAX_TURNS).toBe(200);

    await startTask("org-1", "task-1");

    const input = submitChatMessageMock.mock.calls[0]?.[0] as {
      maxSteps?: number;
    };
    expect(input.maxSteps).toBe(TASK_DEFAULT_MAX_TURNS);
  });

  test("returns {ok:false} and deletes the orphan chat when the running transition loses a race", async () => {
    transitionRunningError = new TaskTransitionErrorMockError(
      "task-1",
      "todo",
      "running",
    );

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({
      ok: false,
      error: "task was started by someone else",
    });
    expect(createChatMock).toHaveBeenCalledTimes(1);
    expect(deleteChatMock).toHaveBeenCalledWith("new-chat-id");
    expect(submitChatMessageMock).not.toHaveBeenCalled();
  });

  test("still returns {ok:false} (and cleans up) for a non-race error on the running transition", async () => {
    transitionRunningError = new Error("db is on fire");

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({ ok: false, error: "db is on fire" });
    expect(deleteChatMock).toHaveBeenCalledWith("new-chat-id");
  });

  test("transitions running -> failed when submitChatMessage throws", async () => {
    submitImpl = () => {
      throw new Error("workflow start blew up");
    };

    const result = await startTask("org-1", "task-1");

    expect(result).toEqual({ ok: false, error: "workflow start blew up" });
    expect(transitionTaskStatusMock).toHaveBeenNthCalledWith(
      2,
      "org-1",
      "task-1",
      "failed",
      { resultSummary: "workflow start blew up" },
    );
  });

  test.each([["archived"], ["buffer-failed"], ["conflict"]] as const)(
    "transitions running -> failed when submitChatMessage returns %s",
    async (kind) => {
      submitOutcome = { kind } as SubmitOutcome;

      const result = await startTask("org-1", "task-1");

      expect(result.ok).toBe(false);
      expect(transitionTaskStatusMock).toHaveBeenNthCalledWith(
        2,
        "org-1",
        "task-1",
        "failed",
        expect.objectContaining({ resultSummary: expect.any(String) }),
      );
    },
  );
});
