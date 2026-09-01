import { beforeEach, describe, expect, mock, test } from "bun:test";

type SessionRecord = {
  id: string;
  sandboxState: { type: "docker" } | null;
};

type ChatRecord = {
  id: string;
  sessionId: string;
  activeStreamId: string | null;
};

let sessionRecord: SessionRecord | null = {
  id: "session-1",
  sandboxState: { type: "docker" },
};
let chatRecord: ChatRecord | null = {
  id: "chat-1",
  sessionId: "session-1",
  activeStreamId: null,
};

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  getChatById: async () => chatRecord,
}));

const sessionContextModulePromise = import("./session-context");

async function getErrorMessage(
  response: Response,
): Promise<string | undefined> {
  const body = (await response.json()) as { error?: string };
  return body.error;
}

describe("session context guards", () => {
  beforeEach(() => {
    sessionRecord = {
      id: "session-1",
      sandboxState: { type: "docker" },
    };
    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      activeStreamId: null,
    };
  });

  test("requireOwnedSession returns 404 when session is missing", async () => {
    sessionRecord = null;
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      sessionId: "session-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await getErrorMessage(result.response)).toBe(
        "We couldn't find that session. It may have been deleted.",
      );
    }
  });

  test("requireOwnedSession returns the session when it exists", async () => {
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      sessionId: "session-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionRecord.id).toBe("session-1");
    }
  });

  test("requireOwnedSessionWithSandboxGuard forwards not-found errors", async () => {
    sessionRecord = null;
    const { requireOwnedSessionWithSandboxGuard } =
      await sessionContextModulePromise;

    const result = await requireOwnedSessionWithSandboxGuard({
      sessionId: "session-1",
      sandboxGuard: () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await getErrorMessage(result.response)).toBe(
        "We couldn't find that session. It may have been deleted.",
      );
    }
  });

  test("requireOwnedSessionWithSandboxGuard returns sandbox error when guard fails", async () => {
    const { requireOwnedSessionWithSandboxGuard } =
      await sessionContextModulePromise;

    const result = await requireOwnedSessionWithSandboxGuard({
      sessionId: "session-1",
      sandboxGuard: () => false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await getErrorMessage(result.response)).toBe(
        "Your workspace hasn't started yet. Start it, then try again.",
      );
    }
  });

  test("requireOwnedSessionChat returns 404 when chat is missing", async () => {
    chatRecord = null;
    const { requireOwnedSessionChat } = await sessionContextModulePromise;

    const result = await requireOwnedSessionChat({
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await getErrorMessage(result.response)).toBe(
        "We couldn't find that chat. It may have been deleted.",
      );
    }
  });

  test("requireOwnedSessionChat returns 404 when chat belongs to another session", async () => {
    chatRecord = {
      id: "chat-1",
      sessionId: "session-2",
      activeStreamId: null,
    };
    const { requireOwnedSessionChat } = await sessionContextModulePromise;

    const result = await requireOwnedSessionChat({
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      expect(await getErrorMessage(result.response)).toBe(
        "We couldn't find that chat. It may have been deleted.",
      );
    }
  });

  test("requireOwnedSessionChat returns session and chat when both exist", async () => {
    const { requireOwnedSessionChat } = await sessionContextModulePromise;

    const result = await requireOwnedSessionChat({
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionRecord.id).toBe("session-1");
      expect(result.chat.id).toBe("chat-1");
    }
  });
});
