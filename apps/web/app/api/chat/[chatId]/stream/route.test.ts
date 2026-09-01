import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mutable state ──────────────────────────────────────────────────

let chatRecord: {
  sessionId: string;
  activeStreamId: string | null;
} | null = {
  sessionId: "session-1",
  activeStreamId: "wrun_active-123",
};

let sessionRecord: {
  id: string;
  userId: string;
} | null = {
  id: "session-1",
  userId: "user-1",
};

let workflowRunStatus: string = "running";
let getRunShouldThrow = false;
let lastStartIndex: number | undefined;

const spies = {
  updateChatActiveStreamId: mock(() => Promise.resolve()),
};

// ── Module mocks ───────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

mock.module("ai", () => ({
  createUIMessageStreamResponse: ({
    stream,
    headers,
  }: {
    stream: ReadableStream;
    headers?: HeadersInit;
  }) => new Response(stream, { status: 200, headers }),
}));

/**
 * Read every chunk a response carries.
 *
 * The "nothing to resume" answer is asserted by its contents, not its status
 * code: the client's resume loop only stops when it reads a `finish` chunk,
 * so an empty-but-successful response is what put it in an infinite loop.
 */
async function readChunks(response: Response): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = (response.body as ReadableStream<unknown> | null)?.getReader();
  if (!reader) return chunks;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

async function expectNoActiveStreamResponse(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-paco-stream-inactive")).toBe("1");
  expect(await readChunks(response)).toEqual([{ type: "finish" }]);
}

function createWorkflowReadableStream(startIndex?: number) {
  const stream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  return Object.assign(stream, {
    getTailIndex: () => Promise.resolve(12),
    startIndex,
  });
}

mock.module("workflow/api", () => ({
  getRun: () => {
    if (getRunShouldThrow) throw new Error("Run not found");
    return {
      status: Promise.resolve(workflowRunStatus),
      getReadable: (options?: { startIndex?: number }) => {
        lastStartIndex = options?.startIndex;
        return createWorkflowReadableStream(options?.startIndex);
      },
    };
  },
}));

mock.module("@/lib/chat/create-cancelable-readable-stream", () => ({
  createCancelableReadableStream: (stream: ReadableStream) => stream,
}));

mock.module("@/lib/db/sessions", () => ({
  getChatById: async () => chatRecord,
  getSessionById: async () => sessionRecord,
  updateChatActiveStreamId: spies.updateChatActiveStreamId,
}));

const routeModulePromise = import("./route");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ── Helpers ────────────────────────────────────────────────────────

function createStreamRequest() {
  return new Request("http://localhost/api/chat/chat-1/stream", {
    method: "GET",
    headers: { cookie: "session=abc" },
  });
}

function createStreamRequestWithStartIndex(startIndex: string) {
  return new Request(
    `http://localhost/api/chat/chat-1/stream?startIndex=${startIndex}`,
    {
      method: "GET",
      headers: { cookie: "session=abc" },
    },
  );
}

const routeContext = {
  params: Promise.resolve({ chatId: "chat-1" }),
};

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  sessionRecord = { id: "session-1", userId: "user-1" };
  chatRecord = {
    sessionId: "session-1",
    activeStreamId: "wrun_active-123",
  };
  workflowRunStatus = "running";
  getRunShouldThrow = false;
  lastStartIndex = undefined;
  Object.values(spies).forEach((s) => s.mockClear());
});

describe("GET /api/chat/[chatId]/stream", () => {
  test("returns 404 when chat not found", async () => {
    chatRecord = null;
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    expect(response.status).toBe(404);
  });

  test("terminates the client's resume loop when no active stream", async () => {
    chatRecord = { sessionId: "session-1", activeStreamId: null };
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    await expectNoActiveStreamResponse(response);
    expect(spies.updateChatActiveStreamId).not.toHaveBeenCalled();
  });

  test("returns stream response when workflow is running", async () => {
    workflowRunStatus = "running";
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-workflow-stream-tail-index")).toBe("12");
    expect(lastStartIndex).toBeUndefined();
    expect(spies.updateChatActiveStreamId).not.toHaveBeenCalled();
  });

  test("passes startIndex to workflow stream when reconnecting", async () => {
    workflowRunStatus = "running";
    const { GET } = await routeModulePromise;

    const response = await GET(
      createStreamRequestWithStartIndex("8"),
      routeContext,
    );

    expect(response.status).toBe(200);
    expect(lastStartIndex).toBe(8);
    expect(response.headers.get("x-workflow-stream-tail-index")).toBe("12");
  });

  test("rejects invalid startIndex", async () => {
    const { GET } = await routeModulePromise;

    const response = await GET(
      createStreamRequestWithStartIndex("invalid"),
      routeContext,
    );

    expect(response.status).toBe(400);
    expect(lastStartIndex).toBeUndefined();
  });

  test("returns stream response when workflow is pending", async () => {
    workflowRunStatus = "pending";
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    expect(response.status).toBe(200);
  });

  test("clears stale ID and terminates the loop when workflow is completed", async () => {
    workflowRunStatus = "completed";
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    await expectNoActiveStreamResponse(response);
    expect(spies.updateChatActiveStreamId).toHaveBeenCalledWith("chat-1", null);
  });

  // Stop cancels the run mid-stream, so the recorded stream has no `finish`
  // chunk of its own. Without a terminator here the client reconnects forever
  // and the UI keeps claiming the agent is still working.
  test("clears stale ID and terminates the loop when workflow is cancelled", async () => {
    workflowRunStatus = "cancelled";
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    await expectNoActiveStreamResponse(response);
    expect(spies.updateChatActiveStreamId).toHaveBeenCalledWith("chat-1", null);
  });

  test("clears stale ID and terminates the loop when workflow is failed", async () => {
    workflowRunStatus = "failed";
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    await expectNoActiveStreamResponse(response);
    expect(spies.updateChatActiveStreamId).toHaveBeenCalledWith("chat-1", null);
  });

  test("clears stale ID and terminates the loop when run is not found", async () => {
    getRunShouldThrow = true;
    const { GET } = await routeModulePromise;

    const response = await GET(createStreamRequest(), routeContext);
    await expectNoActiveStreamResponse(response);
    expect(spies.updateChatActiveStreamId).toHaveBeenCalledWith("chat-1", null);
  });
});
