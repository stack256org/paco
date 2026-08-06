import { beforeEach, describe, expect, mock, test } from "bun:test";

type AuthSession = { user: { id: string } } | null;

type SessionRecord = {
  id: string;
  userId: string;
  sandboxState: { type: "docker" } | null;
};

type ChatRecord = {
  id: string;
  sessionId: string;
  activeStreamId: string | null;
};

let authSession: AuthSession = { user: { id: "user-1" } };
let sessionRecord: SessionRecord | null = {
  id: "session-1",
  userId: "user-1",
  sandboxState: { type: "docker" },
};
let chatRecord: ChatRecord | null = {
  id: "chat-1",
  sessionId: "session-1",
  activeStreamId: null,
};

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => authSession,
}));

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
    authSession = { user: { id: "user-1" } };
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      sandboxState: { type: "docker" },
    };
    chatRecord = {
      id: "chat-1",
      sessionId: "session-1",
      activeStreamId: null,
    };
  });

  test("requireAuthenticatedUser returns 401 when unauthenticated", async () => {
    authSession = null;
    const { requireAuthenticatedUser } = await sessionContextModulePromise;

    const result = await requireAuthenticatedUser();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await getErrorMessage(result.response)).toBe(
        "You've been signed out. Sign in again to continue.",
      );
    }
  });

  test("requireAuthenticatedUser returns user id when authenticated", async () => {
    const { requireAuthenticatedUser } = await sessionContextModulePromise;

    const result = await requireAuthenticatedUser();

    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  test("requireOwnedSession returns 404 when session is missing", async () => {
    sessionRecord = null;
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      userId: "user-1",
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

  test("requireOwnedSession returns 403 when user does not own session", async () => {
    sessionRecord = {
      id: "session-1",
      userId: "other-user",
      sandboxState: { type: "docker" },
    };
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      userId: "user-1",
      sessionId: "session-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await getErrorMessage(result.response)).toBe(
        "This isn't yours to open. Check you're signed in to the right account.",
      );
    }
  });

  test("requireOwnedSession allows custom forbidden message", async () => {
    sessionRecord = {
      id: "session-1",
      userId: "other-user",
      sandboxState: { type: "docker" },
    };
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      userId: "user-1",
      sessionId: "session-1",
      forbiddenMessage:
        "This isn't yours to open. Check you're signed in to the right account.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await getErrorMessage(result.response)).toBe(
        "This isn't yours to open. Check you're signed in to the right account.",
      );
    }
  });

  test("requireOwnedSession returns session when owned", async () => {
    const { requireOwnedSession } = await sessionContextModulePromise;

    const result = await requireOwnedSession({
      userId: "user-1",
      sessionId: "session-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessionRecord.id).toBe("session-1");
    }
  });

  test("requireOwnedSessionWithSandboxGuard forwards ownership errors", async () => {
    sessionRecord = null;
    const { requireOwnedSessionWithSandboxGuard } =
      await sessionContextModulePromise;

    const result = await requireOwnedSessionWithSandboxGuard({
      userId: "user-1",
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
      userId: "user-1",
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
      userId: "user-1",
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
      userId: "user-1",
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

  test("requireOwnedSessionChat returns 403 when user does not own session", async () => {
    sessionRecord = {
      id: "session-1",
      userId: "other-user",
      sandboxState: { type: "docker" },
    };
    const { requireOwnedSessionChat } = await sessionContextModulePromise;

    const result = await requireOwnedSessionChat({
      userId: "user-1",
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await getErrorMessage(result.response)).toBe(
        "This isn't yours to open. Check you're signed in to the right account.",
      );
    }
  });

  test("requireOwnedSessionChat returns session and chat when owned", async () => {
    const { requireOwnedSessionChat } = await sessionContextModulePromise;

    const result = await requireOwnedSessionChat({
      userId: "user-1",
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
