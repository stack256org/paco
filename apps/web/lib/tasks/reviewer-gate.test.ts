import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Task } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

// ── Fake TaskTransitionError, shared with the mocked "@/lib/db/tasks" ──
//
// `reviewer-gate.ts` does `error instanceof TaskTransitionError`, and that
// only works if it is the exact class the mocked module exports — so this is
// defined once here and reused everywhere the mock needs to throw it.
class FakeTaskTransitionError extends Error {
  constructor(message = "task status changed concurrently") {
    super(message);
    this.name = "FakeTaskTransitionError";
  }
}

// ── Mutable spy state ──────────────────────────────────────────────

type TransitionCall = {
  organizationId: string;
  taskId: string;
  to: string;
  patch?: Record<string, unknown>;
};

let transitionCalls: TransitionCall[] = [];
/** When set, the transition to this status rejects with a transition race. */
let transitionRaceOn: string | undefined;

const transitionTaskStatusSpy = mock(
  (
    organizationId: string,
    taskId: string,
    to: string,
    patch?: Record<string, unknown>,
  ) => {
    transitionCalls.push({ organizationId, taskId, to, patch });
    if (transitionRaceOn === to) {
      return Promise.reject(new FakeTaskTransitionError());
    }
    return Promise.resolve({ id: taskId, status: to });
  },
);

mock.module("@/lib/db/tasks", () => ({
  TaskTransitionError: FakeTaskTransitionError,
  transitionTaskStatus: transitionTaskStatusSpy,
}));

type ReviewerRoster = {
  reviewer?: { prompt: string; model?: string; tools?: string[] };
};

let rosterResult: ReviewerRoster = {
  reviewer: { prompt: "You are a reviewer agent." },
};

const getRosterSpy = mock(() => Promise.resolve(rosterResult));
mock.module("@/lib/db/roster", () => ({ getRoster: getRosterSpy }));

let sessionResult: unknown = {
  id: "session-1",
  userId: "user-1",
  branch: "main",
  sandboxState: { type: "docker", sandboxName: "session_1" },
};

const getSessionByIdSpy = mock(() => Promise.resolve(sessionResult));
const claimChatActiveStreamIdSpy = mock(() => Promise.resolve(true));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: getSessionByIdSpy,
  claimChatActiveStreamId: claimChatActiveStreamIdSpy,
}));

let turnResult: unknown = {
  responseMessage: undefined,
  usage: {},
  finishReason: "stop",
  claudeSessionId: "claude-1",
  isError: false,
  structuredOutput: { verdict: "pass" },
};

type RunAgentTurnCall = {
  prompt: string;
  maxTurns?: number;
  options: {
    tools?: string[];
    structuredOutput?: { jsonSchema: Record<string, unknown> };
  };
};

const runAgentTurnSpy = mock((_params: RunAgentTurnCall) =>
  Promise.resolve(turnResult),
);
mock.module("@/lib/agent/run-step", () => ({ runAgentTurn: runAgentTurnSpy }));

type StartCallArgs = [
  {
    chatId: string;
    sessionId: string;
    userId: string;
    messages: { parts: { type: string; text: string }[] }[];
  },
];

const startSpy = mock((_workflow: unknown, _args: StartCallArgs) =>
  Promise.resolve({ runId: "run-1" }),
);
mock.module("workflow/api", () => ({ start: startSpy }));

mock.module("@/app/workflows/chat", () => ({
  runAgentWorkflow: () => undefined,
}));

const sandboxExecSpy = mock(() =>
  Promise.resolve({ success: true, stdout: " file.ts | 2 +-\n" }),
);
const connectSandboxSpy = mock(() => Promise.resolve({ exec: sandboxExecSpy }));

mock.module("@paco/sandbox", () => ({
  connectSandbox: connectSandboxSpy,
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

const { runReviewerGate } = await import("./reviewer-gate");

// ── Helpers ────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "task-1",
    organizationId: "org-1",
    sessionId: "session-1",
    chatId: "chat-1",
    parentTaskId: null,
    title: "Do the thing",
    goal: "Implement the thing end to end.",
    status: "running",
    assignedAgent: null,
    reviewerRejections: 0,
    origin: "user",
    resultSummary: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

function transitionTargets(): string[] {
  return transitionCalls.map((call) => call.to);
}

beforeEach(() => {
  transitionCalls = [];
  transitionRaceOn = undefined;
  transitionTaskStatusSpy.mockClear();
  getRosterSpy.mockClear();
  getSessionByIdSpy.mockClear();
  claimChatActiveStreamIdSpy.mockClear();
  runAgentTurnSpy.mockClear();
  startSpy.mockClear();
  sandboxExecSpy.mockClear();
  connectSandboxSpy.mockClear();

  rosterResult = { reviewer: { prompt: "You are a reviewer agent." } };
  sessionResult = {
    id: "session-1",
    userId: "user-1",
    branch: "main",
    sandboxState: { type: "docker", sandboxName: "session_1" },
  };
  turnResult = {
    responseMessage: undefined,
    usage: {},
    finishReason: "stop",
    claudeSessionId: "claude-1",
    isError: false,
    structuredOutput: { verdict: "pass" },
  };
  claimChatActiveStreamIdSpy.mockImplementation(() => Promise.resolve(true));
  sandboxExecSpy.mockImplementation(() =>
    Promise.resolve({ success: true, stdout: " file.ts | 2 +-\n" }),
  );
});

// ── Tests ──────────────────────────────────────────────────────────

describe("runReviewerGate", () => {
  test("no enabled reviewer: auto-approves via review -> done", async () => {
    rosterResult = {};
    const task = makeTask();

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("skipped");
    expect(transitionTargets()).toEqual(["review", "done"]);
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("pass: moves review -> done with a resultSummary", async () => {
    turnResult = {
      isError: false,
      structuredOutput: { verdict: "pass" },
      responseMessage: {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "Looks correct, tests pass." }],
      },
    };
    const task = makeTask({ reviewerRejections: 0 });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("pass");
    expect(transitionTargets()).toEqual(["review", "done"]);
    expect(transitionCalls[1]?.patch).toMatchObject({
      resultSummary: "Looks correct, tests pass.",
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("fail with retries left: increments rejections and re-kicks the executor", async () => {
    turnResult = {
      isError: false,
      structuredOutput: { verdict: "fail", problems: ["missing tests"] },
      responseMessage: undefined,
    };
    const task = makeTask({ reviewerRejections: 0, chatId: "chat-1" });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    expect(transitionTargets()).toEqual(["review", "running"]);
    expect(transitionCalls[1]?.patch).toMatchObject({
      reviewerRejections: 1,
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    const [options] = startSpy.mock.calls[0]?.[1] ?? [];
    expect(options?.chatId).toBe("chat-1");
    expect(options?.sessionId).toBe("session-1");
    expect(options?.userId).toBe("user-1");
    expect(options?.messages[0]?.parts[0]?.text).toContain("missing tests");

    expect(claimChatActiveStreamIdSpy).toHaveBeenCalledWith("chat-1", "run-1");
  });

  test("third rejection blocks the task instead of re-kicking", async () => {
    turnResult = {
      isError: false,
      structuredOutput: { verdict: "fail", problems: ["still broken"] },
    };
    const task = makeTask({ reviewerRejections: 2 });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    expect(transitionTargets()).toEqual(["review", "blocked"]);
    expect(transitionCalls[1]?.patch).toMatchObject({
      reviewerRejections: 2,
      resultSummary: "still broken",
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("malformed structured output is treated as a fail", async () => {
    turnResult = {
      isError: false,
      // Not a legal verdict — the schema requires "pass" | "fail".
      structuredOutput: { verdict: "maybe-ish" },
    };
    const task = makeTask({ reviewerRejections: 0 });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    expect(transitionTargets()).toEqual(["review", "running"]);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const [options] = startSpy.mock.calls[0]?.[1] ?? [];
    expect(options?.messages[0]?.parts[0]?.text).toContain(
      "reviewer output malformed",
    );
  });

  test("an errored reviewer turn is also treated as malformed", async () => {
    turnResult = {
      isError: true,
      structuredOutput: undefined,
    };
    const task = makeTask({ reviewerRejections: 2 });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    expect(transitionCalls[1]?.to).toBe("blocked");
    expect(transitionCalls[1]?.patch).toMatchObject({
      resultSummary: "reviewer output malformed",
    });
  });

  test("a transition race is swallowed and logged, not thrown", async () => {
    transitionRaceOn = "done";
    turnResult = {
      isError: false,
      structuredOutput: { verdict: "pass" },
    };
    const task = makeTask();

    const errorSpy = mock(() => undefined);
    const originalConsoleError = console.error;
    console.error = errorSpy as unknown as typeof console.error;

    try {
      await expect(runReviewerGate(task, "chat-1")).resolves.toBe("pass");
    } finally {
      console.error = originalConsoleError;
    }

    expect(errorSpy).toHaveBeenCalled();
  });

  test("computes a diff summary and feeds it, with the task goal, to the reviewer turn", async () => {
    const task = makeTask({ goal: "Add the missing empty state." });

    await runReviewerGate(task, "chat-1");

    expect(connectSandboxSpy).toHaveBeenCalledTimes(1);
    expect(sandboxExecSpy).toHaveBeenCalledWith(
      expect.stringContaining("git diff main...HEAD --stat"),
      expect.any(String),
      expect.any(Number),
    );

    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("Add the missing empty state.");
    expect(call?.prompt).toContain("file.ts | 2 +-");
    expect(call?.maxTurns).toBe(15);
    expect(call?.options.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(call?.options.structuredOutput?.jsonSchema).toMatchObject({
      required: ["verdict"],
    });
  });

  test("uses the reviewer roster row's own tools when it restricts them", async () => {
    rosterResult = {
      reviewer: { prompt: "Reviewer.", tools: ["Read", "Grep"] },
    };
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.options.tools).toEqual(["Read", "Grep"]);
  });
});
