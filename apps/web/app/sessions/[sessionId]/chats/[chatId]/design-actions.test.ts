import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// ── `@/lib/session/get-server-session` ────────────────────────────

let authUserId: string | undefined = "user-1";
const getServerSessionMock = mock(() =>
  Promise.resolve(authUserId ? { user: { id: authUserId } } : null),
);
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: getServerSessionMock,
}));

// ── `@/lib/db/sessions` ──────────────────────────────────────────

type SessionRow = { id: string; userId: string; sandboxState: unknown };
type ChatRow = { id: string; sessionId: string };

let sessionRow: SessionRow | undefined = {
  id: "session-1",
  userId: "user-1",
  sandboxState: { sandboxName: "s1" },
};
let chatRow: ChatRow | undefined = { id: "chat-1", sessionId: "session-1" };

const getSessionByIdMock = mock(() => Promise.resolve(sessionRow));
const getChatByIdMock = mock(() => Promise.resolve(chatRow));
const createChatMessageMock = mock((data: unknown) => Promise.resolve(data));
const touchChatMock = mock(() => Promise.resolve(undefined));
mock.module("@/lib/db/sessions", () => ({
  getSessionById: getSessionByIdMock,
  getChatById: getChatByIdMock,
  createChatMessage: createChatMessageMock,
  touchChat: touchChatMock,
}));

// ── `@/lib/org/membership` ───────────────────────────────────────

let memberRole: "owner" | "admin" | "member" | null = "member";
const getMemberRoleMock = mock(() => Promise.resolve(memberRole));
mock.module("@/lib/org/membership", () => ({
  getMemberRole: getMemberRoleMock,
}));

// ── workspace + branch naming ────────────────────────────────────

mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: mock((state: { sandboxName?: string }) => {
    if (!state?.sandboxName) {
      throw new Error("no workspace");
    }
    return `/workspaces/${state.sandboxName}`;
  }),
}));
mock.module("@paco/sandbox", () => ({
  chatBranchName: mock((chatId: string) => `chat/${chatId}`),
}));

// ── `@/lib/design/candidates` ────────────────────────────────────

let acceptResult: { ok: true } | { ok: false; error: string } = { ok: true };
const acceptCandidateMock = mock(
  (_params: {
    sessionWorkspace: string;
    chatId: string;
    index: number;
    chatBranch: string;
  }) => Promise.resolve(acceptResult),
);
const removeCandidatesMock = mock(
  (_params: { sessionWorkspace: string; chatId: string }) =>
    Promise.resolve(undefined),
);
mock.module("@/lib/design/candidates", () => ({
  acceptCandidate: acceptCandidateMock,
  removeCandidates: removeCandidatesMock,
}));

const { acceptDesignAction, cancelDesignAction } =
  await import("./design-actions");

beforeEach(() => {
  authUserId = "user-1";
  sessionRow = {
    id: "session-1",
    userId: "user-1",
    sandboxState: { sandboxName: "s1" },
  };
  chatRow = { id: "chat-1", sessionId: "session-1" };
  memberRole = "member";
  acceptResult = { ok: true };

  getServerSessionMock.mockClear();
  getSessionByIdMock.mockClear();
  getChatByIdMock.mockClear();
  createChatMessageMock.mockClear();
  touchChatMock.mockClear();
  getMemberRoleMock.mockClear();
  acceptCandidateMock.mockClear();
  removeCandidatesMock.mockClear();
});

const input = { sessionId: "session-1", chatId: "chat-1", index: 2 as const };

describe("acceptDesignAction guards", () => {
  test("rejects a signed-out caller", async () => {
    authUserId = undefined;
    await expect(acceptDesignAction(input)).rejects.toThrow();
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });

  test("rejects a caller who does not own the session", async () => {
    sessionRow = {
      id: "session-1",
      userId: "someone-else",
      sandboxState: { sandboxName: "s1" },
    };
    await expect(acceptDesignAction(input)).rejects.toThrow();
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });

  test("rejects a caller who is not an organisation member", async () => {
    memberRole = null;
    await expect(acceptDesignAction(input)).rejects.toThrow();
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });

  test("rejects a chat that belongs to another session", async () => {
    chatRow = { id: "chat-1", sessionId: "another-session" };
    await expect(acceptDesignAction(input)).rejects.toThrow();
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });

  test("rejects a candidate index outside 1..3", async () => {
    await expect(
      acceptDesignAction({ ...input, index: 4 as unknown as 1 | 2 | 3 }),
    ).rejects.toThrow();
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });
});

describe("acceptDesignAction", () => {
  test("merges the chosen candidate into the chat's own branch", async () => {
    const result = await acceptDesignAction(input);

    expect(result.success).toBe(true);
    expect(acceptCandidateMock).toHaveBeenCalledTimes(1);
    expect(acceptCandidateMock.mock.calls[0][0]).toEqual({
      sessionWorkspace: "/workspaces/s1",
      chatId: "chat-1",
      index: 2,
      chatBranch: "chat/chat-1",
    });
  });

  test("posts a chat message announcing the adoption", async () => {
    const result = await acceptDesignAction(input);

    expect(createChatMessageMock).toHaveBeenCalledTimes(1);
    const row = createChatMessageMock.mock.calls[0][0] as {
      chatId: string;
      role: string;
      parts: { parts: Array<{ type: string; text?: string }> };
    };
    expect(row.chatId).toBe("chat-1");
    expect(row.role).toBe("assistant");
    const text = row.parts.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
    expect(text).toContain("candidate 2");
    expect(touchChatMock).toHaveBeenCalledTimes(1);

    if (!result.success) {
      throw new Error("expected success");
    }
    expect(result.message.role).toBe("assistant");
  });

  test("reports a refused merge without posting a message", async () => {
    acceptResult = { ok: false, error: "uncommitted changes" };

    const result = await acceptDesignAction(input);

    expect(result).toEqual({ success: false, error: "uncommitted changes" });
    expect(createChatMessageMock).not.toHaveBeenCalled();
  });

  test("refuses when the session has no workspace on disk yet", async () => {
    sessionRow = { id: "session-1", userId: "user-1", sandboxState: null };

    const result = await acceptDesignAction(input);

    expect(result.success).toBe(false);
    expect(acceptCandidateMock).not.toHaveBeenCalled();
  });
});

describe("cancelDesignAction", () => {
  test("removes every candidate for the chat", async () => {
    const result = await cancelDesignAction({
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result).toEqual({ success: true });
    expect(removeCandidatesMock).toHaveBeenCalledTimes(1);
    expect(removeCandidatesMock.mock.calls[0][0]).toEqual({
      sessionWorkspace: "/workspaces/s1",
      chatId: "chat-1",
    });
  });

  test("rejects a signed-out caller", async () => {
    authUserId = undefined;
    await expect(
      cancelDesignAction({ sessionId: "session-1", chatId: "chat-1" }),
    ).rejects.toThrow();
    expect(removeCandidatesMock).not.toHaveBeenCalled();
  });

  test("rejects a caller who is not an organisation member", async () => {
    memberRole = null;
    await expect(
      cancelDesignAction({ sessionId: "session-1", chatId: "chat-1" }),
    ).rejects.toThrow();
    expect(removeCandidatesMock).not.toHaveBeenCalled();
  });

  test("succeeds quietly when the session never had a workspace", async () => {
    sessionRow = { id: "session-1", userId: "user-1", sandboxState: null };

    const result = await cancelDesignAction({
      sessionId: "session-1",
      chatId: "chat-1",
    });

    expect(result).toEqual({ success: true });
    expect(removeCandidatesMock).not.toHaveBeenCalled();
  });
});
