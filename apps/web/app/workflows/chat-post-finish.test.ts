import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WebAgentUIMessage } from "@/app/types";

// ── Mutable spy state ──────────────────────────────────────────────

let createChatMessageIfNotExistsResult: unknown = { id: "msg-1" };
let isFirstChatMessageResult = false;
let upsertChatMessageScopedResult: { status: string } = {
  status: "inserted",
};

const sandboxExec = mock(() =>
  Promise.resolve({ success: true, stdout: " M file.ts\n" }),
);

const spies = {
  claimChatActiveStreamId: mock(() => Promise.resolve(true)),
  compareAndSetChatActiveStreamId: mock(() => Promise.resolve(true)),
  createChatMessageIfNotExists: mock(
    () =>
      Promise.resolve(createChatMessageIfNotExistsResult) as Promise<unknown>,
  ),
  isFirstChatMessage: mock(
    () => Promise.resolve(isFirstChatMessageResult) as Promise<boolean>,
  ),
  touchChat: mock(() => Promise.resolve()),
  updateChat: mock((_chatId: string, _patch: Record<string, unknown>) =>
    Promise.resolve(),
  ),
  updateChatAssistantActivity: mock(() => Promise.resolve()),
  updateSession: mock((_sessionId: string, _patch: Record<string, unknown>) =>
    Promise.resolve(),
  ),
  upsertChatMessageScoped: mock(() =>
    Promise.resolve(upsertChatMessageScopedResult),
  ),
  recordUsage: mock(() => Promise.resolve()),
  buildActiveLifecycleUpdate: mock(() => ({})),
  buildLifecycleActivityUpdate: mock(() => ({})),
  connectSandbox: mock(() =>
    Promise.resolve({
      workingDirectory: "/workspace",
      exec: sandboxExec,
      getState: () => ({ type: "docker", sandboxId: "sb-1" }),
    }),
  ),
  computeAndCacheDiff: mock(() => Promise.resolve()),
  snapshotTurn: mock(() => Promise.resolve({ sha: "snap1", dirty: true })),
  performAutoCreatePr: mock(() =>
    Promise.resolve({ created: true, syncedExisting: false, skipped: false }),
  ),
};

// ── Module mocks (must appear before the module-under-test import) ──

mock.module("@/lib/db/sessions", () => ({
  claimChatActiveStreamId: spies.claimChatActiveStreamId,
  compareAndSetChatActiveStreamId: spies.compareAndSetChatActiveStreamId,
  createChatMessageIfNotExists: spies.createChatMessageIfNotExists,
  isFirstChatMessage: spies.isFirstChatMessage,
  touchChat: spies.touchChat,
  updateChat: spies.updateChat,
  updateChatAssistantActivity: spies.updateChatAssistantActivity,
  updateSession: spies.updateSession,
  upsertChatMessageScoped: spies.upsertChatMessageScoped,
}));

mock.module("@/lib/db/usage", () => ({
  recordUsage: spies.recordUsage,
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: spies.buildActiveLifecycleUpdate,
  buildLifecycleActivityUpdate: spies.buildLifecycleActivityUpdate,
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
  // The auto-commit and auto-PR steps resolve the chat's worktree path.
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

mock.module("@/lib/diff/compute-diff", () => ({
  computeAndCacheDiff: spies.computeAndCacheDiff,
}));

mock.module("@/lib/git/checkpoint", () => ({
  snapshotTurn: spies.snapshotTurn,
}));

mock.module("@/lib/chat/auto-pr-direct", () => ({
  performAutoCreatePr: spies.performAutoCreatePr,
}));

let distillTurnResult: Promise<void> | Error = Promise.resolve();

const distillTurnSpy = mock(() => {
  if (distillTurnResult instanceof Error) {
    return Promise.reject(distillTurnResult);
  }
  return distillTurnResult;
});

mock.module("@/lib/memory/distill", () => ({
  distillTurn: distillTurnSpy,
}));

let taskByChatIdResult: unknown;
const getTaskByChatIdSpy = mock(() => Promise.resolve(taskByChatIdResult));
const transitionTaskStatusSpy = mock(() => Promise.resolve({}));

mock.module("@/lib/db/tasks", () => ({
  getTaskByChatId: getTaskByChatIdSpy,
  transitionTaskStatus: transitionTaskStatusSpy,
}));

let reviewerGateResult: Promise<string> | Error = Promise.resolve("pass");
const runReviewerGateSpy = mock(() => {
  if (reviewerGateResult instanceof Error) {
    return Promise.reject(reviewerGateResult);
  }
  return reviewerGateResult;
});

mock.module("@/lib/tasks/reviewer-gate", () => ({
  runReviewerGate: runReviewerGateSpy,
}));

const {
  persistUserMessage,
  persistAssistantMessage,
  refreshLifecycleActivity,
  persistSandboxState,
  clearActiveStream,
  refreshDiffCache,
  hasCommitsToProposeStep,
  runAutoCreatePrStep,
  runTurnSnapshotStep,
  distillTurnMemoryStep,
  runTaskCompletionStep,
} = await import("./chat-post-finish");

// ── Helpers ────────────────────────────────────────────────────────

function makeUserMessage(
  overrides?: Partial<WebAgentUIMessage>,
): WebAgentUIMessage {
  return {
    id: "msg-1",
    role: "user",
    parts: [{ type: "text", text: "Hello world, this is a test message" }],
    ...overrides,
  } as WebAgentUIMessage;
}

function makeAssistantMessage(
  overrides?: Partial<WebAgentUIMessage>,
): WebAgentUIMessage {
  return {
    id: "msg-2",
    role: "assistant",
    parts: [{ type: "text", text: "Response" }],
    ...overrides,
  } as WebAgentUIMessage;
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  sandboxExec.mockClear();
  sandboxExec.mockImplementation(() =>
    Promise.resolve({ success: true, stdout: " M file.ts\n" }),
  );
  Object.values(spies).forEach((s) => s.mockClear());
  createChatMessageIfNotExistsResult = { id: "msg-1" };
  isFirstChatMessageResult = false;
  upsertChatMessageScopedResult = { status: "inserted" };
  distillTurnSpy.mockClear();
  distillTurnResult = Promise.resolve();
  getTaskByChatIdSpy.mockClear();
  transitionTaskStatusSpy.mockClear();
  runReviewerGateSpy.mockClear();
  taskByChatIdResult = undefined;
  reviewerGateResult = Promise.resolve("pass");
});

// ─── persistUserMessage ────────────────────────────────────────────

describe("persistUserMessage", () => {
  test("skips non-user messages", async () => {
    await persistUserMessage("chat-1", makeAssistantMessage());
    expect(spies.createChatMessageIfNotExists).not.toHaveBeenCalled();
  });

  test("creates message and touches chat", async () => {
    await persistUserMessage("chat-1", makeUserMessage());

    expect(spies.createChatMessageIfNotExists).toHaveBeenCalledTimes(1);
    expect(spies.touchChat).toHaveBeenCalledWith("chat-1");
  });

  test("returns early when message already exists", async () => {
    createChatMessageIfNotExistsResult = undefined;
    await persistUserMessage("chat-1", makeUserMessage());

    expect(spies.touchChat).not.toHaveBeenCalled();
  });

  test("sets title when first message with short text", async () => {
    isFirstChatMessageResult = true;
    const msg = makeUserMessage({
      parts: [{ type: "text", text: "Fix bug" }],
    });

    await persistUserMessage("chat-1", msg);

    expect(spies.updateChat).toHaveBeenCalledWith("chat-1", {
      title: "Fix bug",
    });
  });

  test("truncates title when text exceeds 80 chars", async () => {
    isFirstChatMessageResult = true;
    const longText = "A".repeat(100);
    const msg = makeUserMessage({
      parts: [{ type: "text", text: longText }],
    });

    await persistUserMessage("chat-1", msg);

    expect(spies.updateChat).toHaveBeenCalledWith("chat-1", {
      title: `${"A".repeat(80)}...`,
    });
  });

  test("skips title when no text parts", async () => {
    isFirstChatMessageResult = true;
    const msg = makeUserMessage({
      parts: [{ type: "tool-invocation" as unknown as "text", text: "" }],
    });

    await persistUserMessage("chat-1", msg);

    // updateChat should not be called since text extraction yields ""
    expect(spies.updateChat).not.toHaveBeenCalled();
  });

  test("does not throw on db error", async () => {
    spies.createChatMessageIfNotExists.mockImplementationOnce(() =>
      Promise.reject(new Error("DB down")),
    );

    // Should not throw
    await persistUserMessage("chat-1", makeUserMessage());
  });
});

// ─── persistAssistantMessage ───────────────────────────────────────

describe("persistAssistantMessage", () => {
  test("upserts assistant message and updates activity on insert", async () => {
    upsertChatMessageScopedResult = { status: "inserted" };

    await persistAssistantMessage("chat-1", makeAssistantMessage());

    expect(spies.upsertChatMessageScoped).toHaveBeenCalledTimes(1);
    expect(spies.updateChatAssistantActivity).toHaveBeenCalledTimes(1);
  });

  test("skips activity update on conflict", async () => {
    upsertChatMessageScopedResult = { status: "conflict" };

    await persistAssistantMessage("chat-1", makeAssistantMessage());

    expect(spies.upsertChatMessageScoped).toHaveBeenCalledTimes(1);
    expect(spies.updateChatAssistantActivity).not.toHaveBeenCalled();
  });

  test("skips activity update on update status", async () => {
    upsertChatMessageScopedResult = { status: "updated" };

    await persistAssistantMessage("chat-1", makeAssistantMessage());

    expect(spies.updateChatAssistantActivity).not.toHaveBeenCalled();
  });

  test("does not throw on db error", async () => {
    spies.upsertChatMessageScoped.mockImplementationOnce(() =>
      Promise.reject(new Error("DB down")),
    );

    await persistAssistantMessage("chat-1", makeAssistantMessage());
  });
});

// ─── refreshLifecycleActivity ──────────────────────────────────────

describe("refreshLifecycleActivity", () => {
  test("updates session lifecycle timing", async () => {
    await refreshLifecycleActivity("session-1");

    expect(spies.buildLifecycleActivityUpdate).toHaveBeenCalledTimes(1);
    expect(spies.updateSession).toHaveBeenCalledTimes(1);
    expect(spies.updateSession).toHaveBeenCalledWith("session-1", {});
  });

  test("does not throw on update error", async () => {
    spies.updateSession.mockImplementationOnce(() =>
      Promise.reject(new Error("DB down")),
    );

    await refreshLifecycleActivity("session-1");
  });
});

// ─── persistSandboxState ───────────────────────────────────────────

describe("persistSandboxState", () => {
  test("connects to sandbox and updates session", async () => {
    await persistSandboxState("session-1", { type: "docker" } as never);

    expect(spies.connectSandbox).toHaveBeenCalledTimes(1);
    expect(spies.updateSession).toHaveBeenCalledTimes(1);
  });

  test("skips update when getState returns undefined", async () => {
    spies.connectSandbox.mockImplementationOnce(
      () => Promise.resolve({ getState: () => undefined }) as never,
    );

    await persistSandboxState("session-1", { type: "docker" } as never);

    expect(spies.updateSession).not.toHaveBeenCalled();
  });

  test("does not throw on connection error", async () => {
    spies.connectSandbox.mockImplementationOnce(() =>
      Promise.reject(new Error("Sandbox unavailable")),
    );

    await persistSandboxState("session-1", { type: "docker" } as never);
  });
});

// ─── clearActiveStream ─────────────────────────────────────────────

describe("clearActiveStream", () => {
  test("calls compareAndSet with correct args", async () => {
    await clearActiveStream("chat-1", "wrun_abc");

    expect(spies.compareAndSetChatActiveStreamId).toHaveBeenCalledWith(
      "chat-1",
      "wrun_abc",
      null,
    );
  });

  test("retries transient db errors before succeeding", async () => {
    spies.compareAndSetChatActiveStreamId
      .mockImplementationOnce(() => Promise.reject(new Error("DB down")))
      .mockImplementationOnce(() => Promise.reject(new Error("DB still down")));

    await clearActiveStream("chat-1", "wrun_abc");

    expect(spies.compareAndSetChatActiveStreamId).toHaveBeenCalledTimes(3);

    const compareAndSetCalls = spies.compareAndSetChatActiveStreamId.mock
      .calls as unknown[][];
    expect(compareAndSetCalls).toEqual([
      ["chat-1", "wrun_abc", null],
      ["chat-1", "wrun_abc", null],
      ["chat-1", "wrun_abc", null],
    ]);
  });

  test("does not throw after retry budget is exhausted", async () => {
    spies.compareAndSetChatActiveStreamId
      .mockImplementationOnce(() => Promise.reject(new Error("DB down")))
      .mockImplementationOnce(() => Promise.reject(new Error("DB still down")))
      .mockImplementationOnce(() =>
        Promise.reject(new Error("DB really down")),
      );

    await clearActiveStream("chat-1", "wrun_abc");

    expect(spies.compareAndSetChatActiveStreamId).toHaveBeenCalledTimes(3);
  });
});

// ─── refreshDiffCache ──────────────────────────────────────────────

describe("refreshDiffCache", () => {
  test("connects sandbox and computes diff", async () => {
    await refreshDiffCache("session-1", { type: "docker" } as never);

    expect(spies.connectSandbox).toHaveBeenCalledTimes(1);
    expect(spies.computeAndCacheDiff).toHaveBeenCalledTimes(1);
  });

  test("does not throw on error", async () => {
    spies.connectSandbox.mockImplementationOnce(() =>
      Promise.reject(new Error("Sandbox unavailable")),
    );

    await refreshDiffCache("session-1", { type: "docker" } as never);
  });
});

// ─── runTurnSnapshotStep ───────────────────────────────────────────

const SANDBOX_STATE = {
  type: "docker",
  sandboxName: "session_session-1",
} as never;

describe("runTurnSnapshotStep", () => {
  test("snapshots the chat's worktree under the turn's id", async () => {
    await runTurnSnapshotStep({
      sandboxState: SANDBOX_STATE,
      chatId: "chat-1",
      turnId: "turn-9",
    });

    expect(spies.snapshotTurn).toHaveBeenCalledTimes(1);
    const call = spies.snapshotTurn.mock.calls.at(-1) as unknown[];
    // The chat's worktree, never the session repository: the branch and the
    // work are in the worktree, and the repository would answer for the
    // default branch instead — silently, and with nothing in it.
    expect(call[1]).toBe("/tmp/paco-workspaces/session_session-1/chats/chat-1");
    expect(call[2]).toBe("chat-1");
    expect(call[3]).toBe("turn-9");
  });

  test("never throws: a turn that worked must not be reported as failed", async () => {
    spies.snapshotTurn.mockImplementationOnce(() =>
      Promise.reject(new Error("git exploded")),
    );

    await runTurnSnapshotStep({
      sandboxState: SANDBOX_STATE,
      chatId: "chat-1",
      turnId: "turn-9",
    });
  });
});

// ─── hasCommitsToProposeStep ───────────────────────────────────────

describe("hasCommitsToProposeStep", () => {
  test("true when the branch is ahead of the remote base", async () => {
    sandboxExec.mockImplementationOnce(() =>
      Promise.resolve({ success: true, stdout: "3\n" }),
    );

    await expect(
      hasCommitsToProposeStep({
        sandboxState: SANDBOX_STATE,
        chatId: "chat-1",
        baseBranch: "main",
      }),
    ).resolves.toBe(true);
  });

  test("false when nothing has been committed — the ordinary case now", async () => {
    sandboxExec.mockImplementationOnce(() =>
      Promise.resolve({ success: true, stdout: "0\n" }),
    );

    await expect(
      hasCommitsToProposeStep({
        sandboxState: SANDBOX_STATE,
        chatId: "chat-1",
        baseBranch: "main",
      }),
    ).resolves.toBe(false);
  });

  test("falls back to the local base when the branch was never pushed", async () => {
    // `origin/main` does not exist, so the first count fails; the local
    // `main` answers instead rather than the step reporting "no commits".
    sandboxExec
      .mockImplementationOnce(() =>
        Promise.resolve({ success: false, stdout: "" }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ success: true, stdout: "2\n" }),
      );

    await expect(
      hasCommitsToProposeStep({
        sandboxState: SANDBOX_STATE,
        chatId: "chat-1",
        baseBranch: "main",
      }),
    ).resolves.toBe(true);
  });

  test("errs towards not proposing when git cannot be read at all", async () => {
    sandboxExec.mockImplementation(() =>
      Promise.resolve({ success: false, stdout: "" }),
    );

    await expect(
      hasCommitsToProposeStep({
        sandboxState: SANDBOX_STATE,
        chatId: "chat-1",
        baseBranch: "main",
      }),
    ).resolves.toBe(false);

    sandboxExec.mockImplementation(() =>
      Promise.resolve({ success: true, stdout: " M file.ts\n" }),
    );
  });

  test("refuses a base branch name that is not one", async () => {
    await expect(
      hasCommitsToProposeStep({
        sandboxState: SANDBOX_STATE,
        chatId: "chat-1",
        baseBranch: "main;rm -rf /",
      }),
    ).resolves.toBe(false);
  });
});

describe("runAutoCreatePrStep", () => {
  test("connects sandbox and performs auto PR creation", async () => {
    await runAutoCreatePrStep({
      sessionId: "session-1",
      chatId: "chat-1",
      baseBranch: "main",
      sessionTitle: "My session",
      repoOwner: "acme",
      repoName: "repo",
      sandboxState: {
        type: "docker",
        sandboxName: "session_session-1",
      } as never,
    });

    expect(spies.connectSandbox).toHaveBeenCalledTimes(1);
    expect(spies.performAutoCreatePr).toHaveBeenCalledTimes(1);
    expect(spies.performAutoCreatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionTitle: "My session",
        repoOwner: "acme",
        repoName: "repo",
      }),
    );
  });

  test("does not throw on error", async () => {
    spies.performAutoCreatePr.mockImplementationOnce(() =>
      Promise.reject(new Error("GitHub error")),
    );

    await runAutoCreatePrStep({
      sessionId: "session-1",
      chatId: "chat-1",
      baseBranch: "main",
      sessionTitle: "My session",
      repoOwner: "acme",
      repoName: "repo",
      sandboxState: {
        type: "docker",
        sandboxName: "session_session-1",
      } as never,
    });
  });
});

// ─── distillTurnMemoryStep ─────────────────────────────────────────

describe("distillTurnMemoryStep", () => {
  test("starts distillation with the given params", async () => {
    await distillTurnMemoryStep({
      chatId: "chat-1",
      sessionRepoDir: "/tmp/repo",
      turnId: "turn-1",
    });

    expect(distillTurnSpy).toHaveBeenCalledWith({
      chatId: "chat-1",
      sessionRepoDir: "/tmp/repo",
      turnId: "turn-1",
    });
  });

  test("awaits distillTurn before resolving", async () => {
    let resolveDistill: () => void = () => undefined;
    distillTurnResult = new Promise<void>((resolve) => {
      resolveDistill = resolve;
    });

    let stepResolved = false;
    const stepPromise = distillTurnMemoryStep({
      chatId: "chat-1",
      sessionRepoDir: "/tmp/repo",
      turnId: "turn-1",
    }).then(() => {
      stepResolved = true;
    });

    // Flush pending microtasks: distillTurn is still pending, so the step
    // must not have resolved yet — it awaits distillTurn, it doesn't fire
    // and walk away.
    await Promise.resolve();
    await Promise.resolve();
    expect(stepResolved).toBe(false);

    resolveDistill();
    await stepPromise;

    expect(stepResolved).toBe(true);
    expect(distillTurnSpy).toHaveBeenCalledTimes(1);
  });

  test("does not throw when distillTurn rejects, and still awaits it", async () => {
    distillTurnResult = new Error("Distillation backend unavailable");

    await expect(
      distillTurnMemoryStep({
        chatId: "chat-1",
        sessionRepoDir: "/tmp/repo",
        turnId: "turn-1",
      }),
    ).resolves.toBeUndefined();

    expect(distillTurnSpy).toHaveBeenCalledTimes(1);
  });

  test("resolves via the timeout guard when distillTurn hangs", async () => {
    // Never resolves — stands in for a hung CLI process.
    distillTurnResult = new Promise<void>(() => undefined);

    const originalSetTimeout = globalThis.setTimeout;
    const fakeSetTimeout = mock(
      (callback: () => void): ReturnType<typeof setTimeout> => {
        // Fire immediately rather than waiting the real 90s, so the test
        // exercises the timeout branch without a 90s-long test.
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );
    globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;

    try {
      await expect(
        distillTurnMemoryStep({
          chatId: "chat-1",
          sessionRepoDir: "/tmp/repo",
          turnId: "turn-1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(fakeSetTimeout).toHaveBeenCalledTimes(1);
  });
});

// ─── runTaskCompletionStep ─────────────────────────────────────────

describe("runTaskCompletionStep", () => {
  test("leaves a chat with no task untouched", async () => {
    taskByChatIdResult = undefined;

    await runTaskCompletionStep({
      chatId: "chat-1",
      isError: false,
      finishReason: "stop",
    });

    expect(getTaskByChatIdSpy).toHaveBeenCalledWith("chat-1");
    expect(transitionTaskStatusSpy).not.toHaveBeenCalled();
    expect(runReviewerGateSpy).not.toHaveBeenCalled();
  });

  test("fails the task outright when the turn errored", async () => {
    taskByChatIdResult = {
      id: "task-1",
      organizationId: "org-1",
      status: "running",
    };

    await runTaskCompletionStep({
      chatId: "chat-1",
      isError: true,
      finishReason: "error: the model refused",
    });

    expect(transitionTaskStatusSpy).toHaveBeenCalledWith(
      "org-1",
      "task-1",
      "failed",
      { resultSummary: "error: the model refused" },
    );
    expect(runReviewerGateSpy).not.toHaveBeenCalled();
  });

  test("routes a clean finish through the reviewer gate", async () => {
    const task = {
      id: "task-1",
      organizationId: "org-1",
      status: "running",
    };
    taskByChatIdResult = task;

    await runTaskCompletionStep({
      chatId: "chat-1",
      isError: false,
      finishReason: "stop",
    });

    expect(runReviewerGateSpy).toHaveBeenCalledWith(task, "chat-1");
    expect(transitionTaskStatusSpy).not.toHaveBeenCalled();
  });

  test("does not throw when the reviewer gate rejects", async () => {
    taskByChatIdResult = {
      id: "task-1",
      organizationId: "org-1",
      status: "running",
    };
    reviewerGateResult = new Error("reviewer gate exploded");

    await expect(
      runTaskCompletionStep({
        chatId: "chat-1",
        isError: false,
        finishReason: "stop",
      }),
    ).resolves.toBeUndefined();
  });

  test("does not throw when the lookup itself fails", async () => {
    getTaskByChatIdSpy.mockImplementationOnce(() =>
      Promise.reject(new Error("DB down")),
    );

    await expect(
      runTaskCompletionStep({
        chatId: "chat-1",
        isError: false,
        finishReason: "stop",
      }),
    ).resolves.toBeUndefined();
  });
});
