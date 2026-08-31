import { beforeEach, describe, expect, mock, test } from "bun:test";
import { BAD_REQUEST, WORKSPACE_ASLEEP } from "@/lib/error-copy";

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

type TestExecResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

const connectCalls: TestSandboxState[] = [];
const statCalls: string[] = [];
const mkdirCalls: Array<{ path: string; recursive: boolean }> = [];
const writeFileCalls: Array<{ path: string; content: string }> = [];
const execCalls: Array<{ command: string; cwd: string; timeoutMs: number }> =
  [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];

let ownedSessionResult: OwnedSessionResult = {
  ok: true,
  sessionRecord: {
    id: "session-1",
    userId: "user-1",
    sandboxState: { type: "docker", sandboxId: "sbx-1" },
  },
};
let connectSandboxError: Error | null = null;
let statImplementation: (path: string) => Promise<TestStats>;
let execImplementation: (command: string) => Promise<TestExecResult>;

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
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        mkdirCalls.push({ path, recursive: options?.recursive ?? false });
      },
      writeFile: async (path: string, content: string) => {
        writeFileCalls.push({ path, content });
      },
      exec: async (command: string, cwd: string, timeoutMs: number) => {
        execCalls.push({ command, cwd, timeoutMs });
        return execImplementation(command);
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

/**
 * A real NUL and a real backslash, kept as constants so no source string in
 * this file needs an escape sequence.
 */
const NUL_BYTE = String.fromCodePoint(0);
const BACKSLASH = String.fromCodePoint(92);

const missingStats: () => Promise<TestStats> = () => {
  throw new Error("ENOENT: no such file or directory");
};

const fileStats: TestStats = {
  isDirectory: () => false,
  isFile: () => true,
  size: 10,
};

const directoryStats: TestStats = {
  isDirectory: () => true,
  isFile: () => false,
  size: 0,
};

/** stat that only knows about the paths it is given. */
function statingOnly(existing: string[]): (path: string) => Promise<TestStats> {
  return async (path: string) => {
    if (existing.includes(path)) {
      return fileStats;
    }
    return missingStats();
  };
}

function entryUrl(query = ""): string {
  return `http://localhost/api/sessions/session-1/files/entry${
    query ? `?${query}` : ""
  }`;
}

function jsonRequest(method: string, body: unknown, query = ""): Request {
  return new Request(entryUrl(query), {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function deleteRequest(query: string): Request {
  return new Request(entryUrl(query), { method: "DELETE" });
}

describe("/api/sessions/[sessionId]/files/entry", () => {
  beforeEach(() => {
    connectCalls.length = 0;
    statCalls.length = 0;
    mkdirCalls.length = 0;
    writeFileCalls.length = 0;
    execCalls.length = 0;
    updateCalls.length = 0;
    connectSandboxError = null;
    ownedSessionResult = {
      ok: true,
      sessionRecord: {
        id: "session-1",
        userId: "user-1",
        sandboxState: { type: "docker", sandboxId: "sbx-1" },
      },
    };
    statImplementation = async () => fileStats;
    execImplementation = async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    });
  });

  describe("POST", () => {
    test("creates an empty file and its parent directories", async () => {
      statImplementation = statingOnly([]);
      const { POST } = await loadRouteModule();

      const response = await POST(
        jsonRequest(
          "POST",
          { path: "apps/web/lib/new-file.ts", kind: "file" },
          "chatId=chat-1",
        ),
        createContext(),
      );
      const body = (await response.json()) as { path: string; kind: string };

      expect(response.status).toBe(201);
      expect(body).toEqual({ path: "apps/web/lib/new-file.ts", kind: "file" });
      expect(mkdirCalls).toEqual([
        { path: "/workspace/chats/chat-1/apps/web/lib", recursive: true },
      ]);
      expect(writeFileCalls).toEqual([
        {
          path: "/workspace/chats/chat-1/apps/web/lib/new-file.ts",
          content: "",
        },
      ]);
    });

    test("creates a directory without writing a file", async () => {
      statImplementation = statingOnly([]);
      const { POST } = await loadRouteModule();

      const response = await POST(
        jsonRequest(
          "POST",
          { path: "apps/web/lib/new-dir", kind: "directory" },
          "chatId=chat-1",
        ),
        createContext(),
      );
      const body = (await response.json()) as { path: string; kind: string };

      expect(response.status).toBe(201);
      expect(body).toEqual({
        path: "apps/web/lib/new-dir",
        kind: "directory",
      });
      expect(mkdirCalls).toEqual([
        {
          path: "/workspace/chats/chat-1/apps/web/lib/new-dir",
          recursive: true,
        },
      ]);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("conflicts when the entry already exists", async () => {
      statImplementation = async () => fileStats;
      const { POST } = await loadRouteModule();

      const response = await POST(
        jsonRequest("POST", { path: "README.md", kind: "file" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(409);
      expect(body.error).toBe(
        "There's already a file or folder with that name.",
      );
      expect(writeFileCalls).toHaveLength(0);
      expect(mkdirCalls).toHaveLength(0);
    });

    test.each([
      "../../etc/passwd",
      "/etc/passwd",
      "apps/../../etc/passwd",
      `nul${NUL_BYTE}byte.ts`,
      "",
      ".",
    ])("rejects the traversing path %s", async (rawPath) => {
      const { POST } = await loadRouteModule();

      const response = await POST(
        jsonRequest("POST", { path: rawPath, kind: "file" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "We couldn't tell which file you meant. Reload the page and try again.",
      );
      expect(statCalls).toHaveLength(0);
      expect(writeFileCalls).toHaveLength(0);
      expect(mkdirCalls).toHaveLength(0);
    });

    test.each([".git", ".git/config", "nested/.git/HEAD"])(
      "refuses to create %s",
      async (rawPath) => {
        const { POST } = await loadRouteModule();

        const response = await POST(
          jsonRequest("POST", { path: rawPath, kind: "file" }),
          createContext(),
        );
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe(
          "That folder holds this workspace's history and can't be edited here.",
        );
        expect(statCalls).toHaveLength(0);
        expect(writeFileCalls).toHaveLength(0);
      },
    );

    test.each([
      [{ path: "a.ts" }, "a missing kind"],
      [{ path: "a.ts", kind: "symlink" }, "an unsupported kind"],
      [{ kind: "file" }, "a missing path"],
    ])("rejects %s bodies", async (body) => {
      const { POST } = await loadRouteModule();

      const response = await POST(jsonRequest("POST", body), createContext());
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toMatch(/body/i);
      expect(writeFileCalls).toHaveLength(0);
    });

    test("rejects a body that is not JSON at all", async () => {
      const { POST } = await loadRouteModule();

      const response = await POST(
        jsonRequest("POST", "not json"),
        createContext(),
      );
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toBe(BAD_REQUEST);
      expect(writeFileCalls).toHaveLength(0);
    });
  });

  describe("PATCH", () => {
    test("moves an entry with both paths shell-quoted", async () => {
      statImplementation = statingOnly(["/workspace/chats/chat-1/old name.ts"]);
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest(
          "PATCH",
          { from: "old name.ts", to: "lib/new name.ts" },
          "chatId=chat-1",
        ),
        createContext(),
      );
      const body = (await response.json()) as { from: string; to: string };

      expect(response.status).toBe(200);
      expect(body).toEqual({ from: "old name.ts", to: "lib/new name.ts" });
      expect(mkdirCalls).toEqual([
        { path: "/workspace/chats/chat-1/lib", recursive: true },
      ]);
      expect(execCalls).toEqual([
        {
          command:
            "mv -- '/workspace/chats/chat-1/old name.ts' '/workspace/chats/chat-1/lib/new name.ts'",
          cwd: "/workspace/chats/chat-1",
          timeoutMs: 30_000,
        },
      ]);
    });

    test("neutralizes a filename that would otherwise close the quote", async () => {
      const hostileName = "evil'; touch pwned.txt";
      statImplementation = statingOnly([`/workspace/${hostileName}`]);
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from: hostileName, to: "safe.txt" }),
        createContext(),
      );

      expect(response.status).toBe(200);
      // The single quote is closed, escaped, and reopened, so `touch` stays
      // part of the filename instead of becoming a second command.
      expect(execCalls[0]?.command).toBe(
        `mv -- '/workspace/evil'${BACKSLASH}''; touch pwned.txt' '/workspace/safe.txt'`,
      );
    });

    test("returns 404 when the source is missing", async () => {
      statImplementation = statingOnly([]);
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from: "missing.ts", to: "other.ts" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(body.error).toBe(
        "That file isn't there any more. It may have been renamed or deleted.",
      );
      expect(execCalls).toHaveLength(0);
    });

    test("returns 409 when the destination exists", async () => {
      statImplementation = statingOnly([
        "/workspace/from.ts",
        "/workspace/to.ts",
      ]);
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from: "from.ts", to: "to.ts" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(409);
      expect(body.error).toBe(
        "There's already a file or folder with that name in the new location.",
      );
      expect(execCalls).toHaveLength(0);
    });

    test.each([
      [".git", "docs/git-backup"],
      ["docs/notes.md", ".git/config"],
      ["nested/.git/HEAD", "notes.md"],
    ])("refuses to move %s to %s", async (from, to) => {
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from, to }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "That folder holds this workspace's history and can't be edited here.",
      );
      expect(execCalls).toHaveLength(0);
      expect(statCalls).toHaveLength(0);
    });

    test.each([
      ["../escape.ts", "notes.md"],
      ["notes.md", "/etc/passwd"],
      ["notes.md", "../../escape.ts"],
    ])("refuses the traversing move %s -> %s", async (from, to) => {
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from, to }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe(
        "We couldn't tell which file you meant. Reload the page and try again.",
      );
      expect(execCalls).toHaveLength(0);
      expect(statCalls).toHaveLength(0);
    });

    test("reports a failing move as a server error", async () => {
      statImplementation = statingOnly(["/workspace/from.ts"]);
      execImplementation = async () => ({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "mv: permission denied",
        truncated: false,
      });
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", { from: "from.ts", to: "to.ts" }),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(body.error).toBe("We couldn't move that. Try again.");
    });

    test.each([
      [{ from: "a.ts" }, "a missing destination"],
      [{ to: "b.ts" }, "a missing source"],
    ])("rejects %s bodies", async (body) => {
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(jsonRequest("PATCH", body), createContext());
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toMatch(/body/i);
      expect(execCalls).toHaveLength(0);
    });

    test("rejects a body that is not JSON at all", async () => {
      const { PATCH } = await loadRouteModule();

      const response = await PATCH(
        jsonRequest("PATCH", "not json"),
        createContext(),
      );
      const parsed = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(parsed.error).toBe(BAD_REQUEST);
      expect(execCalls).toHaveLength(0);
    });
  });

  describe("DELETE", () => {
    test("removes a file with a quoted path", async () => {
      statImplementation = async () => fileStats;
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest("path=apps/web/lib/old%20file.ts&chatId=chat-1"),
        createContext(),
      );
      const body = (await response.json()) as {
        path: string;
        deleted: boolean;
      };

      expect(response.status).toBe(200);
      expect(body).toEqual({
        path: "apps/web/lib/old file.ts",
        deleted: true,
      });
      expect(execCalls).toEqual([
        {
          command:
            "rm -f -- '/workspace/chats/chat-1/apps/web/lib/old file.ts'",
          cwd: "/workspace/chats/chat-1",
          timeoutMs: 30_000,
        },
      ]);
    });

    test("removes a directory recursively", async () => {
      statImplementation = async () => directoryStats;
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest("path=apps/web/generated"),
        createContext(),
      );

      expect(response.status).toBe(200);
      expect(execCalls[0]?.command).toBe(
        "rm -rf -- '/workspace/apps/web/generated'",
      );
    });

    test("neutralizes a hostile filename", async () => {
      statImplementation = async () => fileStats;
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest(`path=${encodeURIComponent("evil'; rm -rf tmp.txt")}`),
        createContext(),
      );

      expect(response.status).toBe(200);
      expect(execCalls[0]?.command).toBe(
        `rm -f -- '/workspace/evil'${BACKSLASH}''; rm -rf tmp.txt'`,
      );
    });

    test("returns 404 when the entry is missing", async () => {
      statImplementation = statingOnly([]);
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest("path=missing.ts"),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(body.error).toBe(
        "That file isn't there any more. It may have been renamed or deleted.",
      );
      expect(execCalls).toHaveLength(0);
    });

    test.each([".git", ".GIT", ".git/objects", "nested/.git"])(
      "refuses to delete %s",
      async (rawPath) => {
        const { DELETE } = await loadRouteModule();

        const response = await DELETE(
          deleteRequest(`path=${encodeURIComponent(rawPath)}`),
          createContext(),
        );
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe(
          "That folder holds this workspace's history and can't be edited here.",
        );
        expect(connectCalls).toHaveLength(0);
        expect(execCalls).toHaveLength(0);
      },
    );

    test.each(["../../etc/passwd", "/etc/passwd", `nul${NUL_BYTE}byte.ts`, ""])(
      "refuses the traversing path %s before connecting",
      async (rawPath) => {
        const { DELETE } = await loadRouteModule();

        const response = await DELETE(
          deleteRequest(`path=${encodeURIComponent(rawPath)}`),
          createContext(),
        );
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe(
          "We couldn't tell which file you meant. Reload the page and try again.",
        );
        expect(connectCalls).toHaveLength(0);
        expect(execCalls).toHaveLength(0);
      },
    );

    test("reports a failing removal as a server error", async () => {
      execImplementation = async () => ({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "rm: permission denied",
        truncated: false,
      });
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest("path=locked.ts"),
        createContext(),
      );
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(body.error).toBe("We couldn't delete that. Try again.");
    });

    test("marks the session hibernated when the sandbox is unavailable", async () => {
      connectSandboxError = new Error("sandbox unavailable: connection closed");
      const { DELETE } = await loadRouteModule();

      const response = await DELETE(
        deleteRequest("path=notes.md"),
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
