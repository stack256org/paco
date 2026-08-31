import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type SandboxState = { sandboxName: string } | null;
type Chat = { id: string; sessionId: string } | null;

let chat: Chat = { id: "chat1", sessionId: "session1" };
let sandboxState: SandboxState = { sandboxName: "sbx" };
let chatLookupThrows = false;

mock.module("@/lib/db/sessions", () => ({
  getChatById: async (id: string) => {
    if (chatLookupThrows) {
      throw new Error("connection terminated unexpectedly");
    }
    return chat && chat.id === id ? chat : null;
  },
  getSessionById: async () => (sandboxState ? { sandboxState } : {}),
}));

/** What the user was asked, if anything. Resolved by the test, not by a user. */
let asked: { reason: string; detail: string; toolName: string } | null = null;
let answer: "allow" | "deny" = "allow";

mock.module("@/lib/agent/approvals/store", () => ({
  requestApproval: async (params: {
    reason: string;
    detail: string;
    toolName: string;
  }) => {
    asked = params;
    return answer;
  },
}));

mock.module("@/lib/agent/workspace-paths", () => ({
  hostChatWorktree: (_state: unknown, chatId: string) =>
    `/workspaces/sbx/chats/${chatId}`,
}));

const { POST } = await import("./route");
const { approvalToken } = await import("@/lib/agent/approvals/token");

type Body = {
  chatId?: unknown;
  toolName?: unknown;
  toolInput?: unknown;
};

function request(body: Body, token: string | null = approvalToken()): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request("http://localhost/api/internal/approvals", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function reset() {
  chat = { id: "chat1", sessionId: "session1" };
  sandboxState = { sandboxName: "sbx" };
  chatLookupThrows = false;
  asked = null;
  answer = "allow";
}

async function post(body: Body, token?: string | null) {
  const response = await POST(
    request(body, token === undefined ? approvalToken() : token),
  );
  return (await response.json()) as { outcome: string; reason?: string };
}

describe("the bearer token", () => {
  test("is compared in constant time", async () => {
    // A `!==` here leaks the correct token one byte at a time through response
    // timing, and this endpoint's token is the only thing standing between
    // anything that can reach localhost and the agent's approvals.
    // `tools-token.ts` already does this.
    const source = await Bun.file(
      new URL("route.ts", import.meta.url).pathname,
    ).text();
    expect(source).toContain("timingSafeEqual");
  });

  test("rejects a wrong, missing, or truncated token", async () => {
    reset();
    for (const token of [null, "", "wrong", approvalToken().slice(0, -1)]) {
      const response = await POST(
        request({ chatId: "chat1", toolName: "Read", toolInput: {} }, token),
      );
      expect(response.status).toBe(403);
    }
  });

  test("accepts the real one", async () => {
    reset();
    expect(
      await post({ chatId: "chat1", toolName: "Read", toolInput: {} }),
    ).toEqual({ outcome: "allow" });
  });
});

describe("a chat whose sandbox is not there", () => {
  /**
   * The endpoint used to answer `allow` for every call in this state, so a
   * chat whose sandbox had not provisioned yet, had failed, or had been reaped
   * ran completely ungated — and that is a state the product reaches normally.
   */
  test("asks before a write instead of allowing it", async () => {
    reset();
    sandboxState = null;
    answer = "deny";

    const body = await post({
      chatId: "chat1",
      toolName: "Write",
      toolInput: { file_path: "src/index.ts" },
    });

    expect(asked).not.toBeNull();
    expect(body.outcome).toBe("deny");
  });

  test("asks before a shell command instead of allowing it", async () => {
    reset();
    sandboxState = null;
    answer = "deny";

    const body = await post({
      chatId: "chat1",
      toolName: "Bash",
      toolInput: { command: "rm -rf dist" },
    });

    expect(body.outcome).toBe("deny");
  });

  test("says why, so the prompt is not a mystery", async () => {
    reset();
    sandboxState = null;

    await post({
      chatId: "chat1",
      toolName: "Write",
      toolInput: { file_path: "src/index.ts" },
    });

    expect(asked?.reason).toContain("workspace");
  });

  test("still lets reads through, so the degradation is not a wall", async () => {
    reset();
    sandboxState = null;

    expect(
      await post({ chatId: "chat1", toolName: "Read", toolInput: {} }),
    ).toEqual({ outcome: "allow" });
    expect(asked).toBeNull();
  });
});

describe("a chat that does not exist", () => {
  test("is denied outright rather than allowed", async () => {
    reset();
    chat = null;

    // There is no chat to raise a card in, so asking would strand the agent
    // until the five-minute timeout. Denying is the same answer, immediately.
    const body = await post({
      chatId: "gone",
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
    });

    expect(body.outcome).toBe("deny");
    expect(body.reason).toBeString();
    expect(asked).toBeNull();
  });
});

describe("a request this endpoint cannot read", () => {
  test("is denied rather than allowed", async () => {
    reset();

    // The agent controls `toolInput`. A shape the schema rejected used to be
    // answered `allow`, which made "send an input the parser chokes on" a
    // bypass for the whole policy.
    for (const body of [
      {},
      { chatId: "chat1" },
      { toolName: "Bash" },
      { chatId: "", toolName: "Bash", toolInput: {} },
    ]) {
      expect((await post(body)).outcome).toBe("deny");
    }
  });

  test("reads a tool input that is not an object as no input at all", async () => {
    reset();

    // Not a parse failure: `Bash` with an unreadable input has no command, and
    // the policy already fails closed on that.
    const body = await post({
      chatId: "chat1",
      toolName: "Bash",
      toolInput: "rm -rf /",
    });

    expect(body.outcome).toBe("allow");
    expect(asked).not.toBeNull();
  });
});

describe("a database that is down", () => {
  test("is denied rather than turned into a 500 the hook allows", async () => {
    reset();
    chatLookupThrows = true;

    // The hook fails *open* on transport errors, so a 500 from here is an
    // allow. An answer the hook honours has to be a 200 that says deny.
    const response = await POST(
      request({
        chatId: "chat1",
        toolName: "Bash",
        toolInput: { command: "rm -rf /" },
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { outcome: string }).toMatchObject({
      outcome: "deny",
    });
  });
});

describe("a provisioned chat", () => {
  test("allows work inside the worktree without asking", async () => {
    reset();

    expect(
      await post({
        chatId: "chat1",
        toolName: "Write",
        toolInput: { file_path: "/workspaces/sbx/chats/chat1/src/a.ts" },
      }),
    ).toEqual({ outcome: "allow" });
    expect(asked).toBeNull();
  });

  test("asks about work outside it, and passes the denial back with a reason", async () => {
    reset();
    answer = "deny";

    const body = await post({
      chatId: "chat1",
      toolName: "Bash",
      toolInput: { command: "echo pwned > /Users/me/.zshrc" },
    });

    expect(asked?.detail).toBe("echo pwned > /Users/me/.zshrc");
    expect(body.outcome).toBe("deny");
    expect(body.reason).toContain("Not approved in Paco");
  });
});
