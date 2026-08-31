import { beforeEach, describe, expect, mock, test } from "bun:test";

type OwnedSessionChatResult =
  | {
      ok: true;
      sessionRecord: { id: string };
      chat: { id: string; sessionId: string };
    }
  | {
      ok: false;
      response: Response;
    };

let ownedSessionChatResult: OwnedSessionChatResult = {
  ok: true,
  sessionRecord: { id: "session-1" },
  chat: { id: "chat-1", sessionId: "session-1" },
};

const markChatReadCalls: string[] = [];

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireOwnedSessionChat: async () => ownedSessionChatResult,
}));

mock.module("@/lib/db/sessions", () => ({
  markChatRead: async (chatId: string) => {
    markChatReadCalls.push(chatId);
  },
}));

const routeModulePromise = import("./route");

function createContext(sessionId = "session-1", chatId = "chat-1") {
  return {
    params: Promise.resolve({ sessionId, chatId }),
  };
}

describe("/api/sessions/[sessionId]/chats/[chatId]/read", () => {
  beforeEach(() => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1" },
      chat: { id: "chat-1", sessionId: "session-1" },
    };
    markChatReadCalls.length = 0;
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
      new Request("http://localhost/api/sessions/session-1/chats/chat-1/read", {
        method: "POST",
      }),
      createContext(),
    );

    expect(response.status).toBe(404);
    expect(markChatReadCalls).toHaveLength(0);
  });

  test("marks chat as read when the ownership check passes", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1/read", {
        method: "POST",
      }),
      createContext(),
    );
    const body = (await response.json()) as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(markChatReadCalls).toEqual(["chat-1"]);
  });
});
