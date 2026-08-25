import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EvalScenario } from "@/lib/evals/discovery";

mock.module("server-only", () => ({}));
mock.module("ai", () => ({ generateId: () => "eval-msg-1" }));
mock.module("nanoid", () => ({ nanoid: () => "eval-chat-1" }));

// ── `@/lib/agent/workspace-paths` ────────────────────────────────
//
// Points every assertion's "host worktree" at a real temp directory the
// test controls, decoupling file-assertion tests from the sandbox state
// shape entirely.
let worktreeDir = "";
const hostChatWorktreeMock = mock(() => worktreeDir);
mock.module("@/lib/agent/workspace-paths", () => ({
  hostChatWorktree: hostChatWorktreeMock,
}));

// ── `@/lib/chat/submit-message` ──────────────────────────────────

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
let submitError: Error | undefined;
const submitChatMessageMock = mock(async (_input: Record<string, unknown>) => {
  if (submitError) {
    throw submitError;
  }
  return submitOutcome;
});
mock.module("@/lib/chat/submit-message", () => ({
  submitChatMessage: submitChatMessageMock,
}));

// ── `workflow/api` ────────────────────────────────────────────────

let runStatus: "pending" | "running" | "completed" | "failed" | "cancelled" =
  "completed";
const getRunMock = mock((_runId: string) => ({
  get status() {
    return Promise.resolve(runStatus);
  },
}));
mock.module("workflow/api", () => ({ getRun: getRunMock }));

// ── `@/lib/sandbox/chat-worktree-removal` ───────────────────────────

type WorktreeRemovalOutcome =
  | { kind: "removed" }
  | { kind: "already-absent" }
  | { kind: "not-running" }
  | { kind: "failed"; reason: string };

/** Records call order across the two cleanup mocks, so tests can assert
 * the worktree is removed strictly before the row is deleted. */
let callOrder: string[] = [];
let worktreeRemovalOutcome: WorktreeRemovalOutcome = { kind: "removed" };
const removeChatWorktreeMock = mock(
  (_sandboxState: unknown, chatId: string) => {
    callOrder.push(`removeChatWorktree:${chatId}`);
    return Promise.resolve(worktreeRemovalOutcome);
  },
);
mock.module("@/lib/sandbox/chat-worktree-removal", () => ({
  removeChatWorktree: removeChatWorktreeMock,
}));

// ── `@/lib/db/session-events` + `@/lib/chat/derive-from-events` ─────

let sessionEventsThrows: Error | undefined;
const listSessionEventsMock = mock(async (_chatId: string) => {
  if (sessionEventsThrows) {
    throw sessionEventsThrows;
  }
  return [
    {
      id: 1,
      event: {
        type: "turn/start" as const,
        turnId: "turn-1",
        messageId: "eval-msg-1",
        prompt: "do the thing",
        policy: "steer" as const,
      },
    },
  ];
});
mock.module("@/lib/db/session-events", () => ({
  listSessionEvents: listSessionEventsMock,
}));

let transcriptText = "The task is done.";
const deriveAssistantMessageMock = mock(() =>
  Promise.resolve({
    id: "eval-transcript",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: transcriptText }],
  }),
);
mock.module("@/lib/chat/derive-from-events", () => ({
  deriveAssistantMessage: deriveAssistantMessageMock,
}));

// ── `@/lib/db/roster` ────────────────────────────────────────────

const rosterSnapshot = {
  explorer: { description: "explores", prompt: "explore" },
};
const getRosterMock = mock(() => Promise.resolve(rosterSnapshot));
mock.module("@/lib/db/roster", () => ({ getRoster: getRosterMock }));

// ── `@/lib/db/eval-runs` ─────────────────────────────────────────

type FinishCall = {
  id: string;
  status: string;
  details: { assertions: unknown[]; harnessError?: string };
};

let finishCalls: FinishCall[] = [];
const startEvalRunMock = mock(
  (input: {
    organizationId: string;
    sessionId: string;
    scenarioName: string;
  }) =>
    Promise.resolve({
      id: "eval-run-1",
      organizationId: input.organizationId,
      sessionId: input.sessionId,
      scenarioName: input.scenarioName,
      status: "running" as const,
      details: null,
      rosterSnapshot,
      startedAt: new Date("2026-08-25T00:00:00Z"),
      finishedAt: null,
    }),
);
const finishEvalRunMock = mock(
  (id: string, params: { status: string; details: FinishCall["details"] }) => {
    finishCalls.push({ id, status: params.status, details: params.details });
    return Promise.resolve({
      id,
      organizationId: "org-1",
      sessionId: "session-1",
      scenarioName: "scenario",
      status: params.status,
      details: params.details,
      rosterSnapshot,
      startedAt: new Date("2026-08-25T00:00:00Z"),
      finishedAt: new Date("2026-08-25T00:01:00Z"),
    });
  },
);
mock.module("@/lib/db/eval-runs", () => ({
  startEvalRun: startEvalRunMock,
  finishEvalRun: finishEvalRunMock,
}));

// ── `@/lib/db/sessions` ──────────────────────────────────────────

let sessionRow:
  | { userId: string; status: string; sandboxState: unknown }
  | undefined;
const getSessionByIdMock = mock(() => Promise.resolve(sessionRow));
const createChatMock = mock(
  (input: {
    id: string;
    sessionId: string;
    title: string;
    modelId?: string | null;
  }) =>
    Promise.resolve({
      id: input.id,
      sessionId: input.sessionId,
      title: input.title,
      modelId: input.modelId ?? null,
      activeStreamId: null as string | null,
    }),
);
const deleteChatMock = mock((chatId: string) => {
  callOrder.push(`deleteChat:${chatId}`);
  return Promise.resolve();
});
mock.module("@/lib/db/sessions", () => ({
  createChat: createChatMock,
  deleteChat: deleteChatMock,
  getSessionById: getSessionByIdMock,
}));

// ── `@/lib/db/user-preferences` ───────────────────────────────────

const getUserPreferencesMock = mock(() =>
  Promise.resolve({ defaultModelId: "sonnet" }),
);
mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: getUserPreferencesMock,
}));

// ── `@paco/sandbox` ────────────────────────────────────────────────

let sandboxExecSuccess = true;
/**
 * `null` on the grep timeout test to simulate `sandbox.exec` returning the
 * same shape a real timed-out `docker exec` does (`exitCode: null`, a
 * "timed out" stderr) — see `sandbox.ts`'s `runDockerCli`.
 */
let transcriptGrepExitCode: number | null = 0;
const sandboxExecMock = mock(
  (command: string, _cwd: string, _timeout: number) => {
    if (command.startsWith("grep ")) {
      return Promise.resolve({
        success: transcriptGrepExitCode === 0,
        exitCode: transcriptGrepExitCode,
        stdout: "",
        stderr:
          transcriptGrepExitCode === null
            ? "Command timed out after 5000ms"
            : "",
        truncated: false,
      });
    }
    return Promise.resolve(
      sandboxExecSuccess
        ? {
            success: true,
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            truncated: false,
          }
        : {
            success: false,
            exitCode: 1,
            stdout: "",
            stderr: "boom",
            truncated: false,
          },
    );
  },
);
const connectSandboxMock = mock(() =>
  Promise.resolve({ exec: sandboxExecMock }),
);
mock.module("@paco/sandbox", () => ({ connectSandbox: connectSandboxMock }));

const { runEvalScenario } = await import("./runner");

function makeScenario(overrides: Partial<EvalScenario> = {}): EvalScenario {
  return {
    name: "smoke",
    prompt: "Create ok.txt containing OK",
    assertions: [{ kind: "file-exists", path: "ok.txt" }],
    maxTurns: 25,
    ...overrides,
  };
}

beforeEach(async () => {
  worktreeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-evals-runner-"));
  submitOutcome = { kind: "streaming", runId: "run-1", stream: null };
  submitError = undefined;
  runStatus = "completed";
  sessionEventsThrows = undefined;
  transcriptText = "The task is done.";
  sessionRow = {
    userId: "user-1",
    status: "running",
    sandboxState: { sandboxName: "s1" },
  };
  sandboxExecSuccess = true;
  transcriptGrepExitCode = 0;
  finishCalls = [];
  callOrder = [];
  worktreeRemovalOutcome = { kind: "removed" };

  hostChatWorktreeMock.mockClear();
  submitChatMessageMock.mockClear();
  getRunMock.mockClear();
  listSessionEventsMock.mockClear();
  deriveAssistantMessageMock.mockClear();
  getRosterMock.mockClear();
  startEvalRunMock.mockClear();
  finishEvalRunMock.mockClear();
  getSessionByIdMock.mockClear();
  createChatMock.mockClear();
  deleteChatMock.mockClear();
  getUserPreferencesMock.mockClear();
  sandboxExecMock.mockClear();
  connectSandboxMock.mockClear();
  removeChatWorktreeMock.mockClear();
});

afterEach(async () => {
  await fs.rm(worktreeDir, { force: true, recursive: true });
});

describe("runEvalScenario", () => {
  test("all assertions passing yields status passed", async () => {
    await fs.writeFile(path.join(worktreeDir, "ok.txt"), "OK", "utf8");

    const scenario = makeScenario({
      assertions: [
        { kind: "file-exists", path: "ok.txt" },
        { kind: "file-contains", path: "ok.txt", needle: "OK" },
        { kind: "command-succeeds", command: "true" },
        { kind: "transcript-matches", pattern: "task is done" },
      ],
    });

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario,
    });

    expect(result.status).toBe("passed");
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.status).toBe("passed");
    expect(finishCalls[0]?.details.assertions).toHaveLength(4);
    expect(
      finishCalls[0]?.details.assertions.every(
        (a) => (a as { passed: boolean }).passed,
      ),
    ).toBe(true);
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
    expect(deleteChatMock).toHaveBeenCalledWith("eval-chat-1");
    // The worktree removal helper must run before the row is deleted —
    // deleting the row first would leave an invisible, unreachable worktree
    // behind if removal ever failed (see `chat-worktree-removal.ts`).
    expect(callOrder).toEqual([
      "removeChatWorktree:eval-chat-1",
      "deleteChat:eval-chat-1",
    ]);
  });

  test("one failing assertion yields status failed naming it", async () => {
    // ok.txt is never created, so file-exists fails while nothing else does.
    const scenario = makeScenario({
      assertions: [
        { kind: "file-exists", path: "ok.txt" },
        { kind: "transcript-matches", pattern: "task is done" },
      ],
    });

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario,
    });

    expect(result.status).toBe("failed");
    const assertions = finishCalls[0]?.details.assertions as Array<{
      kind: string;
      passed: boolean;
      message?: string;
    }>;
    const fileExists = assertions.find((a) => a.kind === "file-exists");
    const transcriptMatch = assertions.find(
      (a) => a.kind === "transcript-matches",
    );
    expect(fileExists?.passed).toBe(false);
    expect(fileExists?.message).toContain("ok.txt");
    expect(transcriptMatch?.passed).toBe(true);
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "removeChatWorktree:eval-chat-1",
      "deleteChat:eval-chat-1",
    ]);
  });

  test("a harness failure (turn never started) yields status error", async () => {
    submitOutcome = { kind: "conflict" };

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario: makeScenario(),
    });

    expect(result.status).toBe("error");
    expect(finishCalls[0]?.details.harnessError).toContain("conflict");
    expect(finishCalls[0]?.details.assertions).toEqual([]);
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
  });

  test("an unexpected exception still cleans up the throwaway chat and yields error", async () => {
    sessionEventsThrows = new Error("event log unavailable");

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario: makeScenario(),
    });

    expect(result.status).toBe("error");
    expect(finishCalls[0]?.details.harnessError).toContain(
      "event log unavailable",
    );
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
    expect(deleteChatMock).toHaveBeenCalledWith("eval-chat-1");
  });

  test("a turn that never completes times out and yields error", async () => {
    runStatus = "running";

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario: makeScenario(),
      timeoutMs: 5,
      pollIntervalMs: 1,
    });

    expect(result.status).toBe("error");
    expect(finishCalls[0]?.details.harnessError).toContain("timed out");
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "removeChatWorktree:eval-chat-1",
      "deleteChat:eval-chat-1",
    ]);
  });

  test("a transcript-matches assertion that times out fails the run, not the harness", async () => {
    // Simulates a pathological pattern: the sandboxed `grep -E` hits its own
    // hard timeout (`exitCode: null`, see `sandbox.ts`'s `runDockerCli`)
    // instead of the JS process ever evaluating the regex itself.
    transcriptGrepExitCode = null;

    const scenario = makeScenario({
      assertions: [{ kind: "transcript-matches", pattern: "(a+)+b" }],
    });

    const result = await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario,
    });

    expect(result.status).toBe("failed");
    const assertions = finishCalls[0]?.details.assertions as Array<{
      kind: string;
      passed: boolean;
      message?: string;
    }>;
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.passed).toBe(false);
    expect(assertions[0]?.message).toContain("timed out");
    expect(deleteChatMock).toHaveBeenCalledTimes(1);
  });

  test("keeps the throwaway chat row when its worktree could not be removed", async () => {
    worktreeRemovalOutcome = {
      kind: "failed",
      reason: "contains modified or untracked files",
    };
    await fs.writeFile(path.join(worktreeDir, "ok.txt"), "OK", "utf8");

    await runEvalScenario({
      organizationId: "org-1",
      sessionId: "session-1",
      scenario: makeScenario(),
    });

    expect(removeChatWorktreeMock).toHaveBeenCalledTimes(1);
    // Deleting the row here would recreate the exact invisible-orphan bug
    // this cleanup exists to prevent, since nothing would point at whatever
    // is still on disk.
    expect(deleteChatMock).not.toHaveBeenCalled();
  });
});
