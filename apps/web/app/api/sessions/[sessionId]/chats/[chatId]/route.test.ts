import { beforeEach, describe, expect, mock, test } from "bun:test";
import { POOLSIDE_DEFAULT_MODEL } from "@paco/poolside-backend";

// The route now pulls in `backend-capabilities.ts` (to attach `capabilities`
// to a PATCH response), which is server-only; the marker throws outside a
// server component and has nothing to do with what is being tested here.
mock.module("server-only", () => ({}));

type OwnedSessionChatResult =
  | {
      ok: true;
      sessionRecord: { id: string; sandboxState?: unknown };
      chat: {
        id: string;
        sessionId: string;
        modelId: string;
        activeStreamId: string | null;
      };
    }
  | {
      ok: false;
      response: Response;
    };

type ChatMessageRecord = {
  id: string;
  parts: Array<{ type: string; text?: string }>;
};

type ChatRecord = {
  id: string;
  sessionId: string;
  title: string;
  modelId: string;
  backend?: string;
};

/** A resumable sandbox, which is what `canOperateOnSandbox` looks for. */
const RUNNING_SANDBOX = {
  type: "docker",
  sandboxName: "session_session-1",
} as const;

let ownedSessionChatResult: OwnedSessionChatResult = {
  ok: true,
  sessionRecord: { id: "session-1", sandboxState: RUNNING_SANDBOX },
  chat: {
    id: "chat-1",
    sessionId: "session-1",
    modelId: "model-1",
    activeStreamId: null,
  },
};
let chatMessages: ChatMessageRecord[] = [
  {
    id: "message-1",
    parts: [{ type: "text", text: "Hello" }],
  },
];

let updatedChat: ChatRecord | null = {
  id: "chat-1",
  sessionId: "session-1",
  title: "Updated",
  modelId: "model-updated",
};
let chatsInSession: Array<{ id: string }> = [
  { id: "chat-1" },
  { id: "chat-2" },
];

const updateChatCalls: Array<{
  chatId: string;
  patch: { title?: string; modelId?: string; backend?: string };
}> = [];
/** Every command the route ran in the workspace, in order. */
const sandboxCommands: string[] = [];
let worktreeRemovalResult = { success: true, stderr: "", stdout: "" };

/*
 * Spread over the real module, not replacing it.
 *
 * `workspace-paths.ts` also imports `workspaceRoot` and `chatWorktreePath`
 * from here, so returning only the three names this test cares about broke
 * every case in the file with "Export named 'workspaceRoot' not found".
 * `connectSandbox` is the only behaviour worth faking; everything else is a
 * pure path helper that is more useful real.
 */
const actualSandbox = await import("@paco/sandbox");

mock.module("@paco/sandbox", () => ({
  ...actualSandbox,
  connectSandbox: async () => ({
    exec: async (command: string) => {
      sandboxCommands.push(command);
      return command.startsWith("git worktree remove")
        ? worktreeRemovalResult
        : { success: true, stderr: "", stdout: "" };
    },
  }),
}));

const deleteChatCalls: string[] = [];

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireOwnedSessionChat: async () => ownedSessionChatResult,
}));

mock.module("@/lib/db/sessions", () => ({
  updateChat: async (
    chatId: string,
    patch: { title?: string; modelId?: string; backend?: string },
  ) => {
    updateChatCalls.push({ chatId, patch });
    return updatedChat;
  },
  getChatMessages: async () => chatMessages,
  getChatsBySessionId: async () => chatsInSession,
  deleteChat: async (chatId: string) => {
    deleteChatCalls.push(chatId);
  },
}));

mock.module("@/lib/db/user-preferences", () => ({
  getUserPreferences: async () => ({
    defaultModelId: "model-default",
    defaultDiffMode: "unified",
    autoCommitPush: false,
    autoCreatePr: false,
    alertsEnabled: true,
    alertSoundEnabled: true,
    modelVariants: [],
  }),
}));

const routeModulePromise = import("./route");

function createContext(sessionId = "session-1", chatId = "chat-1") {
  return {
    params: Promise.resolve({ sessionId, chatId }),
  };
}

function createGetRequest(): Request {
  return new Request("http://localhost/api/sessions/session-1/chats/chat-1");
}

function createPatchRequest(body: unknown): Request {
  return new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/sessions/[sessionId]/chats/[chatId]", () => {
  beforeEach(() => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1", sandboxState: RUNNING_SANDBOX },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        modelId: "model-1",
        activeStreamId: null,
      },
    };
    sandboxCommands.length = 0;
    worktreeRemovalResult = { stderr: "", stdout: "", success: true };
    chatMessages = [
      {
        id: "message-1",
        parts: [{ type: "text", text: "Hello" }],
      },
    ];
    updatedChat = {
      id: "chat-1",
      sessionId: "session-1",
      title: "Updated",
      modelId: "model-updated",
    };
    chatsInSession = [{ id: "chat-1" }, { id: "chat-2" }];
    updateChatCalls.length = 0;
    deleteChatCalls.length = 0;
  });

  test("GET returns the latest chat snapshot", async () => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1" },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        modelId: "model-1",
        activeStreamId: "stream-1",
      },
    };
    chatMessages = [
      {
        id: "message-1",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        id: "message-2",
        parts: [{ type: "text", text: "World" }],
      },
    ];
    const { GET } = await routeModulePromise;

    const response = await GET(createGetRequest(), createContext());
    const body = (await response.json()) as {
      chat: {
        id: string;
        modelId: string;
        effort: string | null;
        activeStreamId: string | null;
      };
      isStreaming: boolean;
      messages: ChatMessageRecord["parts"][];
    };

    expect(response.status).toBe(200);
    expect(body.chat).toEqual({
      id: "chat-1",
      modelId: "model-1",
      effort: null,
      activeStreamId: "stream-1",
    });
    expect(body.isStreaming).toBe(true);
    expect(body.messages).toEqual(chatMessages.map((message) => message.parts));
  });

  test("PATCH returns not-found error from guard", async () => {
    ownedSessionChatResult = {
      ok: false,
      response: Response.json(
        { error: "We couldn't find that chat. It may have been deleted." },
        { status: 404 },
      ),
    };
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ title: "x" }),
      createContext(),
    );

    expect(response.status).toBe(404);
    expect(updateChatCalls).toHaveLength(0);
  });

  test("PATCH returns 400 for invalid JSON", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "PATCH",
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

  test("PATCH returns 400 when neither title nor modelId is provided", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ title: "   " }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Something went wrong sending that request. Reload the page and try again.",
    );
    expect(updateChatCalls).toHaveLength(0);
  });

  test("PATCH trims fields and updates chat", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ title: "  New title  ", modelId: "  model-2  " }),
      createContext(),
    );
    const body = (await response.json()) as { chat: ChatRecord };

    expect(response.status).toBe(200);
    expect(updateChatCalls).toEqual([
      {
        chatId: "chat-1",
        patch: { title: "New title", modelId: "model-2" },
      },
    ]);
    expect(body.chat.id).toBe("chat-1");
  });

  test("PATCH accepts a known backend and returns its capabilities", async () => {
    updatedChat = {
      id: "chat-1",
      sessionId: "session-1",
      title: "Updated",
      modelId: "model-updated",
      backend: "poolside",
    };
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ backend: "poolside" }),
      createContext(),
    );
    const body = (await response.json()) as {
      chat: ChatRecord & {
        backend?: string;
        capabilities?: { id: string; effort: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(body.chat.capabilities?.id).toBe("poolside");
    expect(body.chat.capabilities?.effort).toBe(false);
  });

  /**
   * `modelId` and `backend` used to be written straight through as
   * independent fields, so a chat switched to Poolside kept whatever Claude
   * tier alias it held. The turn survived it — `run-step.ts`'s
   * `resolveModelId` refuses to forward an id the backend does not accept —
   * but the composer renders the stored id, so it showed "opus" on a chat
   * that could only run Laguna.
   */
  test("PATCH moves a stranded model onto the new backend's default", async () => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1", sandboxState: RUNNING_SANDBOX },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        modelId: "opus",
        activeStreamId: null,
      },
    };
    const { PATCH } = await routeModulePromise;

    await PATCH(createPatchRequest({ backend: "poolside" }), createContext());

    expect(updateChatCalls).toEqual([
      {
        chatId: "chat-1",
        patch: { backend: "poolside", modelId: POOLSIDE_DEFAULT_MODEL },
      },
    ]);
  });

  test("PATCH leaves a model the new backend accepts alone", async () => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1", sandboxState: RUNNING_SANDBOX },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        modelId: "poolside/laguna-xs-2.1",
        activeStreamId: null,
      },
    };
    const { PATCH } = await routeModulePromise;

    await PATCH(createPatchRequest({ backend: "poolside" }), createContext());

    expect(updateChatCalls).toEqual([
      { chatId: "chat-1", patch: { backend: "poolside" } },
    ]);
  });

  /** And back: a Poolside id cannot survive a switch to Claude Code. */
  test("PATCH reconciles the model when switching back to Claude Code", async () => {
    ownedSessionChatResult = {
      ok: true,
      sessionRecord: { id: "session-1", sandboxState: RUNNING_SANDBOX },
      chat: {
        id: "chat-1",
        sessionId: "session-1",
        modelId: "poolside/laguna-s-2.1",
        activeStreamId: null,
      },
    };
    const { PATCH } = await routeModulePromise;

    await PATCH(
      createPatchRequest({ backend: "claude-code" }),
      createContext(),
    );

    expect(updateChatCalls).toEqual([
      { chatId: "chat-1", patch: { backend: "claude-code", modelId: "opus" } },
    ]);
  });

  /**
   * A client that switches both at once is judged on what it asked for: the
   * requested model is accepted by the requested backend, so nothing is
   * overridden.
   */
  test("PATCH keeps a model sent alongside the backend it belongs to", async () => {
    const { PATCH } = await routeModulePromise;

    await PATCH(
      createPatchRequest({
        backend: "poolside",
        modelId: "poolside/laguna-xs-2.1",
      }),
      createContext(),
    );

    expect(updateChatCalls).toEqual([
      {
        chatId: "chat-1",
        patch: {
          backend: "poolside",
          modelId: "poolside/laguna-xs-2.1",
        },
      },
    ]);
  });

  /** ...and overridden when it does not belong to it. */
  test("PATCH overrides a model the requested backend cannot run", async () => {
    const { PATCH } = await routeModulePromise;

    await PATCH(
      createPatchRequest({ backend: "poolside", modelId: "opus" }),
      createContext(),
    );

    expect(updateChatCalls).toEqual([
      {
        chatId: "chat-1",
        patch: { backend: "poolside", modelId: POOLSIDE_DEFAULT_MODEL },
      },
    ]);
  });

  /** No backend in the patch, no reconciliation: only the model is written. */
  test("PATCH does not touch the model when no backend is requested", async () => {
    const { PATCH } = await routeModulePromise;

    await PATCH(createPatchRequest({ modelId: "haiku" }), createContext());

    expect(updateChatCalls).toEqual([
      { chatId: "chat-1", patch: { modelId: "haiku" } },
    ]);
  });

  test("PATCH rejects an unrecognised backend value", async () => {
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ backend: "some-future-backend" }),
      createContext(),
    );

    expect(response.status).toBe(400);
    expect(updateChatCalls).toHaveLength(0);
  });

  test("PATCH returns 404 when updateChat returns null", async () => {
    updatedChat = null;
    const { PATCH } = await routeModulePromise;

    const response = await PATCH(
      createPatchRequest({ title: "New" }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe(
      "We couldn't find that chat. It may have been deleted.",
    );
  });

  test("DELETE returns 400 when attempting to delete the only chat", async () => {
    chatsInSession = [{ id: "chat-1" }];
    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "A session needs at least one chat, so this one can't be deleted.",
    );
    expect(deleteChatCalls).toHaveLength(0);
  });

  test("DELETE removes chat when more than one chat exists", async () => {
    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );
    const body = (await response.json()) as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(deleteChatCalls).toEqual(["chat-1"]);
  });

  test("DELETE removes the worktree before the row, and prunes after", async () => {
    const { DELETE } = await routeModulePromise;

    await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );

    // The whole point of the fix: the files go first. Deleting the row first
    // would leave a directory nothing can reach.
    expect(sandboxCommands[0]).toContain("git worktree remove --force");
    expect(sandboxCommands[0]).toContain("chats/chat-1");
    expect(sandboxCommands).toContain("git worktree prune");
    expect(deleteChatCalls).toEqual(["chat-1"]);
  });

  test("DELETE keeps the chat when its worktree could not be removed", async () => {
    worktreeRemovalResult = {
      stderr: "fatal: 'chats/chat-1' contains modified or untracked files",
      stdout: "",
      success: false,
    };

    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );

    expect(response.status).toBe(409);
    // Retryable: the chat is still there, so there is still a handle on the
    // files that were left behind.
    expect(deleteChatCalls).toHaveLength(0);
  });

  test("DELETE still deletes when the worktree was already gone", async () => {
    worktreeRemovalResult = {
      stderr: "fatal: '/w/chats/chat-1' is not a working tree",
      stdout: "",
      success: false,
    };

    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(deleteChatCalls).toEqual(["chat-1"]);
  });

  test("DELETE refuses while the workspace is not running", async () => {
    ownedSessionChatResult = {
      ...(ownedSessionChatResult as { ok: true } & OwnedSessionChatResult),
      sessionRecord: { id: "session-1" },
    } as OwnedSessionChatResult;

    const { DELETE } = await routeModulePromise;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/chats/chat-1", {
        method: "DELETE",
      }),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("isn't running");
    expect(deleteChatCalls).toHaveLength(0);
  });
});
