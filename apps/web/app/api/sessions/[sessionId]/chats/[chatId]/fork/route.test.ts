import { beforeEach, describe, expect, mock, test } from "bun:test";

type OwnedSessionChatResult =
  | {
      ok: true;
      sessionRecord: { id: string };
      chat: {
        id: string;
        sessionId: string;
        title: string;
        modelId: string | null;
        activeStreamId: string | null;
      };
    }
  | {
      ok: false;
      response: Response;
    };

type ChatRecord = {
  id: string;
  sessionId: string;
  title: string;
  modelId: string | null;
};

type ForkResult =
  | { status: "created"; chat: ChatRecord }
  | { status: "message_not_found" }
  | { status: "not_assistant_message" };

let ownedSessionChatResult: OwnedSessionChatResult = {
  ok: true,
  sessionRecord: { id: "session-1" },
  chat: {
    id: "chat-1",
    sessionId: "session-1",
    title: "Original chat",
    modelId: "model-1",
    activeStreamId: null,
  },
};
let existingChat: ChatRecord | null = null;
let forkResult: ForkResult = {
  status: "created",
  chat: {
    id: "fork-chat-1",
    sessionId: "session-1",
    title: "Fork of Original chat",
    modelId: "model-1",
  },
};

const getChatByIdCalls: string[] = [];
const forkCalls: Array<{
  sourceChatId: string;
  throughMessageId: string;
  forkedChat: {
    id: string;
    sessionId: string;
    title: string;
    modelId: string | null;
  };
}> = [];

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireOwnedSessionChat: async () => ownedSessionChatResult,
}));

mock.module("@/lib/db/sessions", () => ({
  getChatById: async (chatId: string) => {
    getChatByIdCalls.push(chatId);
    return existingChat;
  },
  forkChatThroughMessage: async (input: (typeof forkCalls)[number]) => {
    forkCalls.push(input);
    return forkResult;
  },
}));

const routeModulePromise = import("./route");

function createContext(sessionId = "session-1", chatId = "chat-1") {
  return {
    params: Promise.resolve({ sessionId, chatId }),
  };
}

function createPostRequest(body: unknown): Request {
  return new Request(
    "http://localhost/api/sessions/session-1/chats/chat-1/fork",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("/api/sessions/[sessionId]/chats/[chatId]/fork", () => {
  beforeEach(() => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1" },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        title: "Original chat",
        modelId: "model-1",
        activeStreamId: null,
      },
    };
    existingChat = null;
    forkResult = {
      status: "created",
      chat: {
        id: "fork-chat-1",
        sessionId: "session-1",
        title: "Fork of Original chat",
        modelId: "model-1",
      },
    };
    getChatByIdCalls.length = 0;
    forkCalls.length = 0;
  });

  test("returns not-found error from guard", async () => {
    ownedSessionChatResult = {
      ok: false,
      response: Response.json(
        { error: "We couldn't find that chat. It may have been deleted." },
        { status: 404 },
      ),
    };
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-2" }),
      createContext(),
    );

    expect(response.status).toBe(404);
    expect(forkCalls).toHaveLength(0);
  });

  test("returns 400 for invalid JSON", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Something went wrong sending that request. Reload the page and try again.",
    );
  });

  test("returns 400 when messageId is missing", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(createPostRequest({}), createContext());
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Something went wrong sending that request. Reload the page and try again.",
    );
    expect(forkCalls).toHaveLength(0);
  });

  test("returns 400 when provided chat id is invalid", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-2", id: "" }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Something went wrong sending that request. Reload the page and try again.",
    );
    expect(forkCalls).toHaveLength(0);
  });

  test("returns 409 when requested fork chat id already exists", async () => {
    existingChat = {
      id: "fork-chat-1",
      sessionId: "session-1",
      title: "Existing",
      modelId: "model-1",
    };
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-2", id: "fork-chat-1" }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "That chat already exists. Reload the page and try again.",
    );
    expect(getChatByIdCalls).toEqual(["fork-chat-1"]);
    expect(forkCalls).toHaveLength(0);
  });

  test("returns 404 when the selected message does not exist", async () => {
    forkResult = { status: "message_not_found" };
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-missing", id: "fork-chat-1" }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe(
      "We couldn't find that message. It may have been deleted.",
    );
  });

  test("returns 400 when the selected message is not an assistant message", async () => {
    forkResult = { status: "not_assistant_message" };
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-1", id: "fork-chat-1" }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("You can only branch off one of Paco's replies.");
  });

  test("creates a forked chat through the selected assistant message", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createPostRequest({ messageId: "message-2", id: "fork-chat-1" }),
      createContext(),
    );
    const body = (await response.json()) as { chat: ChatRecord };

    expect(response.status).toBe(200);
    expect(forkCalls).toEqual([
      {
        sourceChatId: "chat-1",
        throughMessageId: "message-2",
        forkedChat: {
          id: "fork-chat-1",
          sessionId: "session-1",
          title: "Fork of Original chat",
          modelId: "model-1",
        },
      },
    ]);
    expect(body.chat).toEqual({
      id: "fork-chat-1",
      sessionId: "session-1",
      title: "Fork of Original chat",
      modelId: "model-1",
    });
  });
});
