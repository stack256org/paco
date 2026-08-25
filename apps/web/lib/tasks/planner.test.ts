import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClaudeAgentDefinition } from "@paco/claude-code";
import type { AgentStepResult } from "@/lib/agent/run-step";
import type { Task, TaskOrigin } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

// `resolveWorkCwd` (imported for real, not mocked) delegates to
// `@paco/sandbox` for the host-path arithmetic; faking just that dependency
// keeps the real `hostWorkspaceFor`/`resolveWorkCwd` logic under test.
mock.module("@paco/sandbox", () => ({
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

// ── `@/lib/db/sessions` ──────────────────────────────────────────

let sessionSandboxState: { hostWorkspace: string } | null = {
  hostWorkspace: "/tmp/paco-workspaces/session-1",
};

const getSessionByIdMock = mock(async (_sessionId: string) =>
  sessionSandboxState === null
    ? undefined
    : { id: "session-1", sandboxState: sessionSandboxState },
);
mock.module("@/lib/db/sessions", () => ({
  getSessionById: (sessionId: string) => getSessionByIdMock(sessionId),
}));

// ── `@/lib/db/roster` ────────────────────────────────────────────

let roster: Record<string, ClaudeAgentDefinition> = {
  explorer: { description: "explores", prompt: "explore" },
  executor: { description: "executes", prompt: "execute" },
};

const getRosterMock = mock(async (_organizationId: string) => roster);
mock.module("@/lib/db/roster", () => ({
  getRoster: (organizationId: string) => getRosterMock(organizationId),
}));

// ── `@/lib/db/tasks` ─────────────────────────────────────────────

let nextTaskId = 0;
const createTaskMock = mock(
  async (input: {
    organizationId: string;
    sessionId: string;
    title: string;
    goal: string;
    parentTaskId?: string | null;
    assignedAgent?: string | null;
    origin?: TaskOrigin;
    createdBy?: string | null;
  }) => {
    nextTaskId += 1;
    return {
      id: `task-${nextTaskId}`,
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      chatId: null,
      parentTaskId: input.parentTaskId ?? null,
      title: input.title,
      goal: input.goal,
      status: "todo",
      assignedAgent: input.assignedAgent ?? null,
      reviewerRejections: 0,
      origin: input.origin ?? "user",
      resultSummary: null,
      createdBy: input.createdBy ?? null,
      createdAt: new Date("2026-08-25T00:00:00Z"),
      updatedAt: new Date("2026-08-25T00:00:00Z"),
    } satisfies Task;
  },
);
mock.module("@/lib/db/tasks", () => ({
  createTask: (input: Parameters<typeof createTaskMock>[0]) =>
    createTaskMock(input),
}));

// ── `@/lib/agent/run-step` ───────────────────────────────────────

type RunAgentTurnArgs = Parameters<
  typeof import("@/lib/agent/run-step").runAgentTurn
>[0];

let runAgentTurnResult: Partial<AgentStepResult<never>> = {
  finishReason: "stop",
  isError: false,
  claudeSessionId: "planner-session-1",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    models: {},
  },
};

const runAgentTurnMock = mock(async (_args: RunAgentTurnArgs) => {
  return runAgentTurnResult as AgentStepResult<never>;
});
mock.module("@/lib/agent/run-step", () => ({
  runAgentTurn: (args: RunAgentTurnArgs) => runAgentTurnMock(args),
}));

const { buildPlannerPrompt, planGoal } = await import("./planner");

function structuredResult(
  structuredOutput: unknown,
): Partial<AgentStepResult<never>> {
  return {
    finishReason: "stop",
    isError: false,
    claudeSessionId: "planner-session-1",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    },
    structuredOutput,
  };
}

beforeEach(() => {
  sessionSandboxState = { hostWorkspace: "/tmp/paco-workspaces/session-1" };
  roster = {
    explorer: { description: "explores", prompt: "explore" },
    executor: { description: "executes", prompt: "execute" },
  };
  nextTaskId = 0;
  runAgentTurnResult = structuredResult({
    tasks: [
      { title: "Do A", goal: "Do A in full", assignedAgent: "executor" },
      { title: "Do B", goal: "Do B in full", assignedAgent: null },
    ],
  });

  getSessionByIdMock.mockClear();
  getRosterMock.mockClear();
  createTaskMock.mockClear();
  runAgentTurnMock.mockClear();
});

// ── buildPlannerPrompt ────────────────────────────────────────────

describe("buildPlannerPrompt", () => {
  test("renders the goal, decomposition instructions, and the roster names", () => {
    const prompt = buildPlannerPrompt("Ship the billing page", [
      "explorer",
      "executor",
    ]);

    expect(prompt).toBe(
      [
        "Ship the billing page",
        "",
        "Decompose this goal into 2-12 independent, individually-completable tasks.",
        "Each task's goal must be self-contained: the executor that runs it sees only its own goal text, never this prompt or any other task's goal.",
        "For each task, name an assignedAgent from: explorer, executor — or null if none of them fit.",
      ].join("\n"),
    );
  });

  test("says none when the roster has no enabled agents", () => {
    const prompt = buildPlannerPrompt("Ship it", []);

    expect(prompt).toBe(
      [
        "Ship it",
        "",
        "Decompose this goal into 2-12 independent, individually-completable tasks.",
        "Each task's goal must be self-contained: the executor that runs it sees only its own goal text, never this prompt or any other task's goal.",
        "For each task, name an assignedAgent from: none — or null if none of them fit.",
      ].join("\n"),
    );
  });
});

// ── planGoal ──────────────────────────────────────────────────────

describe("planGoal", () => {
  test("persists a root grouping task plus child tasks with parent links and planner origin", async () => {
    const result = await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship the billing page",
    });

    expect(result).toEqual({
      ok: true,
      rootTaskId: "task-1",
      taskIds: ["task-2", "task-3"],
    });

    expect(createTaskMock).toHaveBeenCalledTimes(3);

    const rootCall = createTaskMock.mock.calls[0]?.[0];
    expect(rootCall).toMatchObject({
      organizationId: "org-1",
      sessionId: "session-1",
      title: "Ship the billing page",
      goal: "Ship the billing page",
      origin: "planner",
    });
    expect(rootCall?.parentTaskId).toBeUndefined();

    const childCalls = createTaskMock.mock.calls.slice(1).map(([c]) => c);
    expect(childCalls).toEqual([
      expect.objectContaining({
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: "task-1",
        title: "Do A",
        goal: "Do A in full",
        assignedAgent: "executor",
        origin: "planner",
      }),
      expect.objectContaining({
        organizationId: "org-1",
        sessionId: "session-1",
        parentTaskId: "task-1",
        title: "Do B",
        goal: "Do B in full",
        assignedAgent: null,
        origin: "planner",
      }),
    ]);
  });

  test("truncates the root task's title to 80 characters", async () => {
    const goal = "x".repeat(100);

    await planGoal({ organizationId: "org-1", sessionId: "session-1", goal });

    const rootCall = createTaskMock.mock.calls[0]?.[0];
    expect(rootCall?.title).toBe(`${"x".repeat(80)}...`);
    expect(rootCall?.goal).toBe(goal);
  });

  test("passes createdBy through to every created task", async () => {
    await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship it",
      createdBy: "user-9",
    });

    for (const [call] of createTaskMock.mock.calls) {
      expect(call.createdBy).toBe("user-9");
    }
  });

  test("runs one headless turn against the session repo dir, read-only", async () => {
    await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship the billing page",
    });

    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    const args = runAgentTurnMock.mock.calls[0]?.[0];
    expect(args?.maxTurns).toBe(20);
    expect(args?.options.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(args?.options.structuredOutput).toEqual({
      jsonSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                goal: { type: "string" },
                assignedAgent: { type: ["string", "null"] },
              },
              required: ["title", "goal"],
            },
          },
        },
        required: ["tasks"],
      },
    });
    expect(args?.options.sandbox.hostWorkingDirectory).toBe(
      "/tmp/paco-workspaces/session-1/repo",
    );
    expect(args?.prompt).toBe(
      buildPlannerPrompt("Ship the billing page", ["explorer", "executor"]),
    );
  });

  test("malformed structured output: {ok:false}, nothing persisted", async () => {
    runAgentTurnResult = structuredResult({ not: "a task list" });

    const result = await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship it",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  test("no structured output at all: {ok:false}, nothing persisted", async () => {
    runAgentTurnResult = structuredResult(undefined);

    const result = await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship it",
    });

    expect(result.ok).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  test("zero tasks: {ok:false}, nothing persisted", async () => {
    runAgentTurnResult = structuredResult({ tasks: [] });

    const result = await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship it",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  test("an assignedAgent outside the roster is nulled, with a warning", async () => {
    runAgentTurnResult = structuredResult({
      tasks: [
        {
          title: "Do A",
          goal: "Do A in full",
          assignedAgent: "not-a-real-agent",
        },
      ],
    });
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const result = await planGoal({
        organizationId: "org-1",
        sessionId: "session-1",
        goal: "Ship it",
      });

      expect(result.ok).toBe(true);
      const childCall = createTaskMock.mock.calls[1]?.[0];
      expect(childCall?.assignedAgent).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("more than 12 tasks are truncated to 12, with a warning", async () => {
    runAgentTurnResult = structuredResult({
      tasks: Array.from({ length: 13 }, (_, i) => ({
        title: `Task ${i}`,
        goal: `Goal ${i}`,
        assignedAgent: null,
      })),
    });
    const warnSpy = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const result = await planGoal({
        organizationId: "org-1",
        sessionId: "session-1",
        goal: "Ship it",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.taskIds).toHaveLength(12);
      }
      // 1 root + 12 children.
      expect(createTaskMock).toHaveBeenCalledTimes(13);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("session with no sandbox state: {ok:false}, nothing persisted", async () => {
    sessionSandboxState = null;

    const result = await planGoal({
      organizationId: "org-1",
      sessionId: "session-1",
      goal: "Ship it",
    });

    expect(result.ok).toBe(false);
    expect(runAgentTurnMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
