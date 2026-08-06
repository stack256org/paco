import { beforeEach, describe, expect, mock, test } from "bun:test";
import { BAD_REQUEST, WORKSPACE_ASLEEP } from "@/lib/error-copy";

type AuthResult =
  | {
      ok: true;
      userId: string;
    }
  | {
      ok: false;
      response: Response;
    };

type TestSandboxState = {
  type: string;
  sandboxId?: string;
};

type OwnedSessionResult =
  | {
      ok: true;
      sessionRecord: {
        id: string;
        userId: string;
        sandboxState: TestSandboxState | null;
      };
    }
  | {
      ok: false;
      response: Response;
    };

type TestStats = {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
};

const connectCalls: TestSandboxState[] = [];
const statCalls: string[] = [];
const readFileCalls: Array<{ path: string; encoding: "utf-8" }> = [];
const writeFileCalls: Array<{
  path: string;
  content: string;
  encoding: "utf-8";
}> = [];
const mkdirCalls: Array<{ path: string; recursive: boolean }> = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];

let authResult: AuthResult = { ok: true, userId: "user-1" };
let ownedSessionResult: OwnedSessionResult = {
  ok: true,
  sessionRecord: {
    id: "session-1",
    userId: "user-1",
    sandboxState: {
      type: "docker",
      sandboxId: "sbx-1",
    },
  },
};
let connectSandboxError: Error | null = null;
let statImplementation: (path: string) => Promise<TestStats>;
let readFileImplementation: (
  path: string,
  encoding: "utf-8",
) => Promise<string>;

// These fixtures address the sandbox as `/workspace`; the real resolver
// returns a host path derived from the sandbox name. What matters here is
// that the chat id reaches it, which `resolveWorkCwd` receives either way.
mock.module("@/lib/agent/workspace-paths", () => ({
  resolveWorkCwd: (_state: unknown, chatId?: string | null) =>
    chatId ? `/workspace/chats/${chatId}` : "/workspace",
  hostChatWorktree: (_state: unknown, chatId: string) =>
    `/workspace/chats/${chatId}`,
}));

mock.module("@/app/api/sessions/_lib/session-context", () => ({
  requireAuthenticatedUser: async () => authResult,
  requireOwnedSessionWithSandboxGuard: async () => ownedSessionResult,
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: async (sandboxState: TestSandboxState) => {
    if (connectSandboxError) {
      throw connectSandboxError;
    }

    connectCalls.push(sandboxState);
    return {
      workingDirectory: "/workspace",
      stat: async (path: string) => {
        statCalls.push(path);
        return statImplementation(path);
      },
      readFile: async (path: string, encoding: "utf-8") => {
        readFileCalls.push({ path, encoding });
        return readFileImplementation(path, encoding);
      },
      writeFile: async (path: string, content: string, encoding: "utf-8") => {
        writeFileCalls.push({ path, content, encoding });
      },
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        mkdirCalls.push({ path, recursive: options?.recursive ?? false });
      },
    };
  },
}));

mock.module("@/lib/db/sessions", () => ({
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
  },
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildHibernatedLifecycleUpdate: () => ({ lifecycleState: "hibernated" }),
}));

mock.module("@/lib/sandbox/utils", () => ({
  clearSandboxState: () => null,
  clearUnavailableSandboxState: () => null,
  hasRuntimeSandboxState: (state: TestSandboxState | null) =>
    Boolean(state?.sandboxId),
  isSandboxUnavailableError: (message: string) =>
    message.toLowerCase().includes("sandbox unavailable"),
}));

let routeImportVersion = 0;

async function loadRouteModule() {
  routeImportVersion += 1;
  return import(`./route?test=${routeImportVersion}`);
}

function createContext(sessionId = "session-1") {
  return {
    params: Promise.resolve({ sessionId }),
  };
}

/** A real NUL, kept out of the source as an escape-free constant. */
const NUL_BYTE = String.fromCodePoint(0);

function missingFile(path: string): Error {
  return new Error(`ENOENT: no such file or directory, stat '${path}'`);
}

function putRequest(query: string, body: unknown): Request {
  return new Request(
    `http://localhost/api/sessions/session-1/files/content?${query}`,
    {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("/api/sessions/[sessionId]/files/content", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    statCalls.length = 0;
    readFileCalls.length = 0;
    writeFileCalls.length = 0;
    mkdirCalls.length = 0;
    updateCalls.length = 0;
    connectSandboxError = null;
    authResult = { ok: true, userId: "user-1" };
    ownedSessionResult = {
      ok: true,
      sessionRecord: {
        id: "session-1",
        userId: "user-1",
        sandboxState: {
          type: "docker",
          sandboxId: "sbx-1",
        },
      },
    };
    statImplementation = async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 42,
    });
    readFileImplementation = async () => "export const answer = 42;\n";
  });

  test("returns auth failures from the session guard", async () => {
    authResult = {
      ok: false,
      response: Response.json(
        { error: "You've been signed out. Sign in again to continue." },
        { status: 401 },
      ),
    };
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=apps/web/lib/test.ts",
      ),
      createContext(),
    );

    expect(response.status).toBe(401);
    expect(connectCalls).toHaveLength(0);
  });

  test("rejects invalid or traversing paths before connecting to the sandbox", async () => {
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=../secrets.txt",
      ),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "We couldn't tell which file you meant. Reload the page and try again.",
    );
    expect(connectCalls).toHaveLength(0);
    expect(statCalls).toHaveLength(0);
  });

  test("returns a normalized file preview for valid workspace files", async () => {
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=apps%5Cweb%5Clib%5Ctest%20file.ts",
      ),
      createContext(),
    );
    const body = (await response.json()) as {
      path: string;
      content: string;
      size: number;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      path: "apps/web/lib/test file.ts",
      content: "export const answer = 42;\n",
      size: 42,
    });
    expect(connectCalls).toEqual([
      {
        type: "docker",
        sandboxId: "sbx-1",
      },
    ]);
    expect(statCalls).toEqual(["/workspace/apps/web/lib/test file.ts"]);
    expect(readFileCalls).toEqual([
      {
        path: "/workspace/apps/web/lib/test file.ts",
        encoding: "utf-8",
      },
    ]);
  });

  test("rejects directories instead of trying to read them", async () => {
    statImplementation = async () => ({
      isDirectory: () => true,
      isFile: () => false,
      size: 0,
    });
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=apps/web/components",
      ),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Directories cannot be previewed");
    expect(readFileCalls).toHaveLength(0);
  });

  test("returns not found when the file is missing", async () => {
    statImplementation = async () => {
      throw missingFile("/workspace/missing.ts");
    };
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=apps/web/lib/missing.ts",
      ),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe(
      "That file isn't there any more. It may have been renamed or deleted.",
    );
    expect(readFileCalls).toHaveLength(0);
  });

  test("marks the session hibernated when the sandbox is unavailable", async () => {
    connectSandboxError = new Error("sandbox unavailable: connection closed");
    const { GET } = await loadRouteModule();

    const response = await GET(
      new Request(
        "http://localhost/api/sessions/session-1/files/content?path=apps/web/lib/test.ts",
      ),
      createContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe(WORKSPACE_ASLEEP);
    expect(updateCalls).toEqual([
      {
        sessionId: "session-1",
        patch: {
          sandboxState: null,
          lifecycleState: "hibernated",
        },
      },
    ]);
  });

  describe("PUT", () => {
    test("creates a missing file, including its parent directories", async () => {
      statImplementation = async (path: string) => {
        throw missingFile(path);
      };
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=apps/web/lib/new-file.ts&chatId=chat-1", {
          content: "export const answer = 42;\n",
        }),
        createContext(),
      );
      const body = (await response.json()) as { path: string; size: number };

      expect(response.status).toBe(200);
      expect(body).toEqual({
        path: "apps/web/lib/new-file.ts",
        size: 26,
      });
      expect(mkdirCalls).toEqual([
        { path: "/workspace/chats/chat-1/apps/web/lib", recursive: true },
      ]);
      expect(writeFileCalls).toEqual([
        {
          path: "/workspace/chats/chat-1/apps/web/lib/new-file.ts",
          content: "export const answer = 42;\n",
          encoding: "utf-8",
        },
      ]);
    });

    test("overwrites an existing file and reports its utf-8 byte size", async () => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", { content: "héllo" }),
        createContext(),
      );
      const body = (await response.json()) as { path: string; size: number };

      expect(response.status).toBe(200);
      // "é" is two bytes in utf-8, so the byte length is not the string length.
      expect(body).toEqual({ path: "README.md", size: 6 });
      expect(writeFileCalls).toEqual([
        {
          path: "/workspace/README.md",
          content: "héllo",
          encoding: "utf-8",
        },
      ]);
    });

    test.each([
      ["../../etc/passwd", "traversal"],
      ["/etc/passwd", "absolute"],
      ["apps/../../etc/passwd", "traversal through a real prefix"],
      [`nul${NUL_BYTE}byte.ts`, "NUL byte"],
      ["", "empty"],
    ])("rejects %s paths before touching the sandbox", async (rawPath) => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest(`path=${encodeURIComponent(rawPath)}`, { content: "nope" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "We couldn't tell which file you meant. Reload the page and try again.",
      );
      expect(connectCalls).toHaveLength(0);
      expect(writeFileCalls).toHaveLength(0);
    });

    test.each([
      ".git/config",
      ".git/hooks/pre-commit",
      "nested/repo/.git/HEAD",
    ])("refuses to write inside %s", async (rawPath) => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest(`path=${encodeURIComponent(rawPath)}`, { content: "nope" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "That folder holds this workspace's history and can't be edited here.",
      );
      expect(connectCalls).toHaveLength(0);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("refuses to overwrite a directory", async () => {
      statImplementation = async () => ({
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
      });
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=apps/web/components", { content: "nope" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("There's already a folder with that name.");
      expect(writeFileCalls).toHaveLength(0);
    });

    test("rejects content containing a NUL byte", async () => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", { content: `binary${NUL_BYTE}payload` }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "This file isn't text, so it can't be edited here.",
      );
      expect(writeFileCalls).toHaveLength(0);
    });

    test("rejects content over the size limit", async () => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=big.txt", { content: "a".repeat(2_000_001) }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(413);
      expect(body.error).toBe("This file is too big to save.");
      expect(writeFileCalls).toHaveLength(0);
    });

    test("accepts content exactly at the size limit", async () => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=big.txt", { content: "a".repeat(2_000_000) }),
        createContext(),
      );

      expect(response.status).toBe(200);
      expect(writeFileCalls).toHaveLength(1);
    });

    test.each([
      [{ content: 42 }, "a non-string content"],
      [{}, "a missing content"],
    ])("rejects %o bodies", async (body) => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", body),
        createContext(),
      );
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toMatch(/reload the page/i);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("rejects a body that is not JSON at all", async () => {
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", "not json at all"),
        createContext(),
      );
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toBe(BAD_REQUEST);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("returns auth failures before reading the body", async () => {
      authResult = {
        ok: false,
        response: Response.json(
          { error: "You've been signed out. Sign in again to continue." },
          { status: 401 },
        ),
      };
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", { content: "nope" }),
        createContext(),
      );

      expect(response.status).toBe(401);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("marks the session hibernated when the sandbox is unavailable", async () => {
      connectSandboxError = new Error("sandbox unavailable: connection closed");
      const { PUT } = await loadRouteModule();

      const response = await PUT(
        putRequest("path=README.md", { content: "nope" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(409);
      expect(body.error).toBe(WORKSPACE_ASLEEP);
      expect(updateCalls).toEqual([
        {
          sessionId: "session-1",
          patch: {
            sandboxState: null,
            lifecycleState: "hibernated",
          },
        },
      ]);
    });
  });
});
