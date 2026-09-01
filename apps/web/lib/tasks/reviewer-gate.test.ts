import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Task } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

// ── Fake TaskTransitionError, shared with the mocked "@/lib/db/tasks" ──
//
// `reviewer-gate.ts` does `error instanceof TaskTransitionError`, and that
// only works if it is the exact class the mocked module exports — so this is
// defined once here and reused everywhere the mock needs to throw it.
class FakeTaskTransitionError extends Error {
  readonly kind: "illegal" | "race";

  constructor(
    kind: "illegal" | "race" = "race",
    message = "task status changed concurrently",
  ) {
    super(message);
    this.name = "FakeTaskTransitionError";
    this.kind = kind;
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
/** When set, the transition to this status rejects as an ILLEGAL edge. */
let transitionIllegalOn: string | undefined;
/** When set, the transition to this status rejects with a plain (non-race) error. */
let transitionGenericErrorOn: string | undefined;

const transitionTaskStatusSpy = mock(
  (
    organizationId: string,
    taskId: string,
    to: string,
    patch?: Record<string, unknown>,
  ) => {
    transitionCalls.push({ organizationId, taskId, to, patch });
    if (transitionRaceOn === to) {
      return Promise.reject(new FakeTaskTransitionError("race"));
    }
    if (transitionIllegalOn === to) {
      return Promise.reject(
        new FakeTaskTransitionError(
          "illegal",
          `Task "${taskId}" cannot transition to "${to}"`,
        ),
      );
    }
    if (transitionGenericErrorOn === to) {
      return Promise.reject(new Error("the database is unreachable"));
    }
    return Promise.resolve({ id: taskId, status: to });
  },
);

mock.module("@/lib/db/tasks", () => ({
  TaskTransitionError: FakeTaskTransitionError,
  transitionTaskStatus: transitionTaskStatusSpy,
}));

type ReviewerRoster = {
  reviewer?: {
    description?: string;
    prompt: string;
    model?: string;
    tools?: string[];
  };
};

let rosterResult: ReviewerRoster = {
  reviewer: { prompt: "You are a reviewer agent." },
};

const getRosterSpy = mock(() => Promise.resolve(rosterResult));
mock.module("@/lib/db/roster", () => ({ getRoster: getRosterSpy }));

let sessionResult: unknown = {
  id: "session-1",
  status: "running",
  branch: "main",
  sandboxState: { type: "docker", sandboxName: "session_1" },
};

let chatResult: unknown = {
  id: "chat-1",
  activeStreamId: null,
  backend: "poolside",
};

const getSessionByIdSpy = mock(() => Promise.resolve(sessionResult));
const getChatByIdSpy = mock(() => Promise.resolve(chatResult));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: getSessionByIdSpy,
  getChatById: getChatByIdSpy,
}));

/** The chat-submission outcome `submitChatMessage` resolves with. */
let submitChatMessageOutcome: unknown = {
  kind: "streaming",
  runId: "run-1",
  stream: undefined,
};

type SubmitChatMessageCall = {
  chatId: string;
  sessionId: string;
  messages: { parts: { type: string; text: string }[] }[];
  requestUrl: string;
  authSession: unknown;
  sessionStatus: string;
  activeStreamId: string | null;
  maxSteps?: number;
};

const submitChatMessageSpy = mock((_input: SubmitChatMessageCall) =>
  Promise.resolve(submitChatMessageOutcome),
);
mock.module("@/lib/chat/submit-message", () => ({
  submitChatMessage: submitChatMessageSpy,
}));

const TASK_DEFAULT_MAX_TURNS_FIXTURE = 200;
mock.module("@/lib/tasks/start", () => ({
  TASK_DEFAULT_MAX_TURNS: TASK_DEFAULT_MAX_TURNS_FIXTURE,
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
  chatId?: string;
  chatBackend?: string | null;
  approval?: { url: string; token: string };
  options: {
    customInstructions?: string;
    tools?: string[];
    disallowedTools?: string[];
    structuredOutput?: { jsonSchema: Record<string, unknown> };
  };
};

const runAgentTurnSpy = mock((_params: RunAgentTurnCall) =>
  Promise.resolve(turnResult),
);
mock.module("@/lib/agent/run-step", () => ({ runAgentTurn: runAgentTurnSpy }));

/**
 * The backend the chat runs on, as far as its capabilities go.
 * `structuredOutput: false` is Poolside: it returns free text whatever schema
 * it is handed (`packages/agent-backend/interface.ts`).
 */
let backendStructuredOutput: boolean | undefined;
const resolveBackendSpy = mock(() =>
  Promise.resolve({
    capabilities: () => ({
      id: backendStructuredOutput === false ? "poolside" : "claude-code",
      ...(backendStructuredOutput === undefined
        ? {}
        : { structuredOutput: backendStructuredOutput }),
    }),
  }),
);
mock.module("@/lib/agent/backend-factory", () => ({
  resolveBackend: resolveBackendSpy,
}));

const sandboxExecSpy = mock(() =>
  Promise.resolve({ success: true, stdout: " file.ts | 2 +-\n" }),
);
const connectSandboxSpy = mock(() => Promise.resolve({ exec: sandboxExecSpy }));

// The approval hook's endpoint and shared secret. Mocked so the assertions
// below name exact values rather than re-deriving `appLoopbackUrl()`'s port
// and a freshly-minted random token. This must stay independent of
// `APP_URL`/`appUrl()` — the loopback callback bypasses the public origin
// entirely (see `appLoopbackUrl`'s doc in `lib/app-url.ts`).
mock.module("@/lib/app-url", () => ({
  appLoopbackUrl: () => "http://127.0.0.1:3066",
}));
mock.module("@/lib/agent/approvals/token", () => ({
  approvalToken: () => "reviewer-approval-secret",
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: connectSandboxSpy,
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

const { runReviewerGate, kickExecutorFixTurn } =
  await import("./reviewer-gate");

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
  transitionIllegalOn = undefined;
  transitionGenericErrorOn = undefined;
  transitionTaskStatusSpy.mockClear();
  getRosterSpy.mockClear();
  getSessionByIdSpy.mockClear();
  getChatByIdSpy.mockClear();
  submitChatMessageSpy.mockClear();
  runAgentTurnSpy.mockClear();
  resolveBackendSpy.mockClear();
  backendStructuredOutput = undefined;
  sandboxExecSpy.mockClear();
  connectSandboxSpy.mockClear();

  rosterResult = { reviewer: { prompt: "You are a reviewer agent." } };
  sessionResult = {
    id: "session-1",
    status: "running",
    branch: "main",
    sandboxState: { type: "docker", sandboxName: "session_1" },
  };
  chatResult = { id: "chat-1", activeStreamId: null, backend: "poolside" };
  turnResult = {
    responseMessage: undefined,
    usage: {},
    finishReason: "stop",
    claudeSessionId: "claude-1",
    isError: false,
    structuredOutput: { verdict: "pass" },
  };
  submitChatMessageOutcome = {
    kind: "streaming",
    runId: "run-1",
    stream: undefined,
  };
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
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
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
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
  });

  test("fail with retries left: increments rejections and re-kicks the executor via submitChatMessage", async () => {
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

    expect(submitChatMessageSpy).toHaveBeenCalledTimes(1);
    const call = submitChatMessageSpy.mock.calls[0]?.[0];
    expect(call?.chatId).toBe("chat-1");
    expect(call?.sessionId).toBe("session-1");
    expect(call?.sessionStatus).toBe("running");
    expect(call?.activeStreamId).toBeNull();
    expect(call?.maxSteps).toBe(TASK_DEFAULT_MAX_TURNS_FIXTURE);
    expect(call?.messages[0]?.parts[0]?.text).toContain("missing tests");
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
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
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
    expect(submitChatMessageSpy).toHaveBeenCalledTimes(1);
    const call = submitChatMessageSpy.mock.calls[0]?.[0];
    expect(call?.messages[0]?.parts[0]?.text).toContain(
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

  test("a backend that cannot produce structured output blocks the task instead of reviewing it", async () => {
    backendStructuredOutput = false;
    const task = makeTask();

    const outcome = await runReviewerGate(task, "chat-1");

    // Not "pass": a review that cannot run has not approved anything, and
    // silently letting the work through is the one outcome a safety gate
    // must never produce. Not "failed" either — the work is not known to be
    // bad, the reviewer is unavailable — so the task parks for a human.
    expect(outcome).toBe("fail");
    expect(transitionTargets()).toEqual(["blocked"]);
    expect(transitionCalls[0]?.patch?.resultSummary).toContain(
      "structured output",
    );
    // And the reviewer turn is never run: it would burn a whole agent turn
    // to produce an answer known in advance to be unusable.
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
  });

  test("a backend that does support structured output reviews as normal", async () => {
    backendStructuredOutput = true;
    turnResult = { isError: false, structuredOutput: { verdict: "pass" } };
    const task = makeTask();

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("pass");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  test("a backend that says nothing about structured output is trusted with it", async () => {
    // `undefined` means yes — the assumption every backend written before
    // the field existed was built on.
    backendStructuredOutput = undefined;
    turnResult = { isError: false, structuredOutput: { verdict: "pass" } };

    const outcome = await runReviewerGate(makeTask(), "chat-1");

    expect(outcome).toBe("pass");
    expect(runAgentTurnSpy).toHaveBeenCalledTimes(1);
  });

  test("an illegal transition is not swallowed as a race — it surfaces", async () => {
    // The exact shape that hid `review -> blocked` for a whole branch: the
    // gate asked for a transition the state machine did not have, the error
    // was logged as "a race", and the gate returned "fail" as though it had
    // blocked the task — while the task never moved at all.
    transitionIllegalOn = "blocked";
    turnResult = {
      isError: false,
      structuredOutput: { verdict: "fail", problems: ["still broken"] },
    };
    const task = makeTask({ reviewerRejections: 2 });

    await expect(runReviewerGate(task, "chat-1")).rejects.toThrow(
      "cannot transition",
    );
  });

  test("a non-TaskTransitionError from transitionTaskStatus propagates", async () => {
    transitionGenericErrorOn = "review";
    const task = makeTask();

    await expect(runReviewerGate(task, "chat-1")).rejects.toThrow(
      "the database is unreachable",
    );
  });

  test("a missing session blocks the task instead of leaving it running", async () => {
    sessionResult = undefined;
    const task = makeTask({ sessionId: "session-missing" });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    // No "review" transition at all: there is nothing to review or resume,
    // so this never enters the reviewer flow in the first place.
    expect(transitionTargets()).toEqual(["blocked"]);
    expect(transitionCalls[0]?.patch?.resultSummary).toContain(
      "session-missing",
    );
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
  });

  test("a null sessionId blocks the task instead of crashing", async () => {
    const task = makeTask({ sessionId: null });

    const outcome = await runReviewerGate(task, "chat-1");

    expect(outcome).toBe("fail");
    expect(transitionTargets()).toEqual(["blocked"]);
    expect(getSessionByIdSpy).not.toHaveBeenCalled();
    expect(runAgentTurnSpy).not.toHaveBeenCalled();
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
  });

  test("computes a diff summary and feeds task content, delimited, to the reviewer turn", async () => {
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
    expect(call?.prompt).toContain("<goal>");
    expect(call?.prompt).toContain("Add the missing empty state.");
    expect(call?.prompt).toContain("</goal>");
    expect(call?.prompt).toContain("<diff>");
    expect(call?.prompt).toContain("file.ts | 2 +-");
    expect(call?.prompt).toContain("</diff>");
    expect(call?.prompt.toLowerCase()).toContain("not instructions");
    expect(call?.maxTurns).toBe(15);
    expect(call?.options.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(call?.options.disallowedTools).toEqual([
      "Write",
      "Edit",
      "NotebookEdit",
    ]);
    expect(call?.options.structuredOutput?.jsonSchema).toMatchObject({
      required: ["verdict"],
    });
  });

  test("truncates an oversized diff summary with a marker", async () => {
    const longStdout = "x".repeat(9000);
    sandboxExecSpy.mockImplementationOnce(() =>
      Promise.resolve({ success: true, stdout: longStdout }),
    );
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    const diffMatch = call?.prompt.match(/<diff>\n([\s\S]*?)\n<\/diff>/);
    const diffContent = diffMatch?.[1] ?? "";
    expect(diffContent.length).toBeLessThan(longStdout.length);
    expect(diffContent).toContain("…truncated");
    expect(diffContent.length).toBeLessThanOrEqual(
      8000 + "…truncated".length + 1,
    );
  });

  test("keeps the reviewer roster's own prompt out of the turn prompt, in customInstructions instead", async () => {
    rosterResult = {
      reviewer: {
        description: "Reviews implementation work.",
        prompt: "Verify the diff matches the goal exactly.",
      },
    };
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.options.customInstructions).toContain(
      "Reviews implementation work.",
    );
    expect(call?.options.customInstructions).toContain(
      "Verify the diff matches the goal exactly.",
    );
    expect(call?.prompt).not.toContain(
      "Verify the diff matches the goal exactly.",
    );
  });

  /**
   * The reviewer keeps `Bash` — running the project's own tests is a large
   * part of what a useful review is — so, unlike the planner, it cannot be
   * made safe by restriction alone. It has a real chat, so it gets the real
   * gate instead.
   */
  test("installs the approval hook on the reviewer turn, addressed to the task's chat", async () => {
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.chatId).toBe("chat-1");
    expect(call?.approval).toEqual({
      url: "http://127.0.0.1:3066/api/internal/approvals",
      token: "reviewer-approval-secret",
    });
  });

  test("runs the reviewer on the chat's own backend rather than defaulting to claude-code", async () => {
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.chatBackend).toBe("poolside");
  });

  test("leaves the backend unset when the chat row cannot be read", async () => {
    chatResult = undefined;
    const task = makeTask();

    await runReviewerGate(task, "chat-1");

    const call = runAgentTurnSpy.mock.calls[0]?.[0];
    expect(call?.chatBackend).toBeUndefined();
    // The gate is still installed: it depends on the chat ID, which the
    // caller supplied, not on the row being readable.
    expect(call?.chatId).toBe("chat-1");
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

describe("kickExecutorFixTurn", () => {
  test("submits through submitChatMessage and does not throw on a streaming outcome", async () => {
    await expect(
      kickExecutorFixTurn({
        sessionId: "session-1",
        chatId: "chat-1",
        problems: ["missing tests"],
      }),
    ).resolves.toBeUndefined();

    expect(submitChatMessageSpy).toHaveBeenCalledTimes(1);
  });

  test.each(["archived", "buffer-failed", "conflict"] as const)(
    "throws when submitChatMessage resolves a non-streaming outcome (%s)",
    async (kind) => {
      submitChatMessageOutcome = { kind };

      await expect(
        kickExecutorFixTurn({
          sessionId: "session-1",
          chatId: "chat-1",
          problems: [],
        }),
      ).rejects.toThrow(kind);
    },
  );

  test("throws when the session cannot be found", async () => {
    sessionResult = undefined;

    await expect(
      kickExecutorFixTurn({
        sessionId: "session-missing",
        chatId: "chat-1",
        problems: [],
      }),
    ).rejects.toThrow('Session "session-missing" not found');
  });

  test("throws when the chat cannot be found", async () => {
    chatResult = undefined;

    await expect(
      kickExecutorFixTurn({
        sessionId: "session-1",
        chatId: "chat-missing",
        problems: [],
      }),
    ).rejects.toThrow('Chat "chat-missing" not found');
  });
});
