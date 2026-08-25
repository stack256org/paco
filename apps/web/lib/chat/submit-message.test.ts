import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

let existingChatMessage: { id: string } | null = null;
let existingRunStatus = "completed";
let getRunShouldThrow = false;
let claimActiveStreamDefaultResult = true;
let compareAndSetDefaultResult = true;
let compareAndSetResults: boolean[] = [];
let startCalls: unknown[][] = [];
let routeEvents: string[] = [];
let appendSessionEventsStrictShouldThrow = false;
let latestChat: { activeStreamId: string | null } | null = null;

const claimChatActiveStreamIdSpy = mock(
  async () => claimActiveStreamDefaultResult,
);
const compareAndSetChatActiveStreamIdSpy = mock(async () => {
  const nextResult = compareAndSetResults.shift();
  return nextResult ?? compareAndSetDefaultResult;
});
const createChatMessageIfNotExistsSpy = mock(async ({ id }: { id: string }) => {
  routeEvents.push("persist-user");
  if (existingChatMessage?.id === id) {
    return null;
  }
  return { id };
});
const touchChatSpy = mock(async () => {
  routeEvents.push("touch-chat");
});
const isFirstChatMessageSpy = mock(async () => true);
const updateChatSpy = mock(async () => {
  routeEvents.push("update-chat");
});
const getChatByIdSpy = mock(async (_chatId: string) => latestChat);
const appendSessionEventsStrictSpy = mock(
  async (_chatId: string, _events: unknown[]) => {
    routeEvents.push("append-session-events");
    if (appendSessionEventsStrictShouldThrow) {
      throw new Error("insert failed");
    }
  },
);

mock.module("ai", () => ({
  generateId: () => "gen-id-1",
}));

mock.module("workflow/api", () => ({
  start: async (...args: unknown[]) => {
    routeEvents.push("start-workflow");
    startCalls.push(args);
    return {
      runId: "wrun_test-123",
      getReadable: () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
    };
  },
  getRun: () => {
    if (getRunShouldThrow) {
      throw new Error("Run not found");
    }
    return {
      status: Promise.resolve(existingRunStatus),
      getReadable: () =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      cancel: () => Promise.resolve(),
    };
  },
}));

mock.module("@/app/workflows/chat", () => ({
  runAgentWorkflow: async () => {},
}));

mock.module("@/app/api/chat/_lib/persist-tool-results", () => ({
  persistAssistantMessagesWithToolResults: async () => {},
}));

mock.module("@/lib/chat/create-cancelable-readable-stream", () => ({
  createCancelableReadableStream: (stream: ReadableStream) => stream,
}));

mock.module("@/lib/db/sessions", () => ({
  claimChatActiveStreamId: claimChatActiveStreamIdSpy,
  compareAndSetChatActiveStreamId: compareAndSetChatActiveStreamIdSpy,
  createChatMessageIfNotExists: createChatMessageIfNotExistsSpy,
  getChatById: getChatByIdSpy,
  isFirstChatMessage: isFirstChatMessageSpy,
  touchChat: touchChatSpy,
  updateChat: updateChatSpy,
}));

mock.module("@/lib/db/session-events", () => ({
  appendSessionEventsStrict: appendSessionEventsStrictSpy,
}));

const { submitChatMessage } = await import("./submit-message");

afterAll(() => {
  // Nothing to restore — no real network or filesystem access happened.
});

function userMessage(id: string, text: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

const BASE_INPUT = {
  chatId: "chat-1",
  sessionId: "session-1",
  userId: "user-1",
  requestUrl: "http://localhost/api/chat",
  authSession: null,
};

describe("submitChatMessage", () => {
  beforeEach(() => {
    existingChatMessage = null;
    existingRunStatus = "completed";
    getRunShouldThrow = false;
    claimActiveStreamDefaultResult = true;
    compareAndSetDefaultResult = true;
    compareAndSetResults = [];
    startCalls = [];
    routeEvents = [];
    appendSessionEventsStrictShouldThrow = false;
    latestChat = null;
    claimChatActiveStreamIdSpy.mockClear();
    compareAndSetChatActiveStreamIdSpy.mockClear();
    createChatMessageIfNotExistsSpy.mockClear();
    touchChatSpy.mockClear();
    isFirstChatMessageSpy.mockClear();
    updateChatSpy.mockClear();
    appendSessionEventsStrictSpy.mockClear();
    getChatByIdSpy.mockClear();
  });

  test("returns 'archived' without touching the workflow or the DB", async () => {
    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "archived",
      activeStreamId: null,
    });

    expect(outcome).toEqual({ kind: "archived" });
    expect(startCalls).toHaveLength(0);
    expect(createChatMessageIfNotExistsSpy).not.toHaveBeenCalled();
  });

  test("starts a new workflow and returns a streaming outcome when no turn is active", async () => {
    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "running",
      activeStreamId: null,
    });

    expect(outcome.kind).toBe("streaming");
    if (outcome.kind === "streaming") {
      expect(outcome.runId).toBe("wrun_test-123");
    }
    expect(startCalls).toHaveLength(1);
    expect(claimChatActiveStreamIdSpy).toHaveBeenCalledWith(
      "chat-1",
      "wrun_test-123",
    );
  });

  test("buffers as steer/buffered and reconnects to the live run when a turn is active", async () => {
    existingRunStatus = "running";

    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "running",
      activeStreamId: "wrun_existing-456",
    });

    expect(outcome).toMatchObject({
      kind: "streaming",
      runId: "wrun_existing-456",
    });
    expect(startCalls).toHaveLength(0);
    expect(appendSessionEventsStrictSpy).toHaveBeenCalledWith("chat-1", [
      { type: "steer/buffered", messageId: "m1", text: "hi" },
    ]);
  });

  test("returns 'buffer-failed' when the durable steer append throws", async () => {
    existingRunStatus = "running";
    appendSessionEventsStrictShouldThrow = true;

    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "running",
      activeStreamId: "wrun_existing-456",
    });

    expect(outcome).toEqual({ kind: "buffer-failed" });
    expect(startCalls).toHaveLength(0);
  });

  test("returns 'conflict' when a different run still owns the stream slot", async () => {
    claimActiveStreamDefaultResult = false;

    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "running",
      activeStreamId: null,
    });

    expect(outcome).toEqual({ kind: "conflict" });
  });

  test("returns 'conflict' when the stale active stream cannot be reconciled", async () => {
    // The run has already finished (not running/pending) but clearing the
    // stale slot keeps losing the compare-and-set race, and every re-fetch
    // of the chat still sees the same stream id — so the reconciliation
    // loop exhausts its attempts without ever reaching "ready" or "resume".
    compareAndSetDefaultResult = false;
    latestChat = { activeStreamId: "wrun_missing-789" };

    const outcome = await submitChatMessage({
      ...BASE_INPUT,
      messages: [userMessage("m1", "hi")],
      sessionStatus: "running",
      activeStreamId: "wrun_missing-789",
    });

    expect(outcome).toEqual({ kind: "conflict" });
  });
});
