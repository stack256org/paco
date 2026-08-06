import { beforeEach, describe, expect, mock, test } from "bun:test";
mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  userId: string;
  status: "running" | "archived";
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  cloneUrl: string | null;
  prNumber: number | null;
  prStatus: "open" | "merged" | "closed" | null;
  sandboxState: {
    type: "docker";
    sandboxName?: string;
    expiresAt?: number;
  } | null;
  lifecycleState: "active" | "archived" | null;
  lifecycleError: string | null;
  sandboxExpiresAt: Date | null;
  hibernateAfter: Date | null;
}

interface MockSandboxExecResult {
  success: boolean;
  stdout: string;
}

interface MockSandbox {
  workingDirectory: string;
  exec: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<MockSandboxExecResult>;
  stop: () => Promise<void>;
}

let sessionRecord: TestSessionRecord | null = null;
let sandboxQueue: MockSandbox[] = [];

const spies = {
  getSessionById: mock(async (_sessionId: string) => {
    if (!sessionRecord) {
      return null;
    }

    return {
      ...sessionRecord,
      sandboxState: sessionRecord.sandboxState
        ? { ...sessionRecord.sandboxState }
        : null,
    };
  }),
  updateSession: mock(
    async (_sessionId: string, patch: Record<string, unknown>) => {
      if (!sessionRecord) {
        return null;
      }

      sessionRecord = {
        ...sessionRecord,
        ...(patch as Partial<TestSessionRecord>),
      };

      return {
        ...sessionRecord,
        sandboxState: sessionRecord.sandboxState
          ? { ...sessionRecord.sandboxState }
          : null,
      };
    },
  ),
  connectSandbox: mock(async () => {
    const sandbox = sandboxQueue.shift();
    if (!sandbox) {
      throw new Error("sandbox connection failed");
    }

    return sandbox;
  }),
  getUserGitHubToken: mock(async () => "repo-token"),
  findPullRequest: mock(
    async (): Promise<{ number: number; state: string } | null> => null,
  ),
};

mock.module("@/lib/db/sessions", () => ({
  getSessionById: spies.getSessionById,
  updateSession: spies.updateSession,
  getLatestChatIdForSession: async () => "chat-1",
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
  chatBranchName: (chatId: string) => `chat/${chatId}`,
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

mock.module("@/lib/db/github-tokens", () => ({
  getGithubToken: spies.getUserGitHubToken,
}));

mock.module("@/lib/github/gh-pr", () => ({
  findPullRequest: spies.findPullRequest,
}));

const archiveSessionModulePromise = import("./archive-session");

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    status: "running",
    repoOwner: "acme",
    repoName: "widgets",
    branch: "feature/session-1",
    cloneUrl: "https://github.com/acme/widgets.git",
    prNumber: 42,
    prStatus: "open",
    sandboxState: {
      type: "docker",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    },
    lifecycleState: "active",
    lifecycleError: null,
    sandboxExpiresAt: new Date("2025-01-01T00:00:00.000Z"),
    hibernateAfter: new Date("2025-01-01T00:10:00.000Z"),
    ...overrides,
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    workingDirectory: "/workspace",
    exec: async () => ({ success: true, stdout: "feature/session-1\n" }),
    stop: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  sessionRecord = makeSessionRecord();
  sandboxQueue = [];
  Object.values(spies).forEach((spy) => spy.mockClear());

  spies.getUserGitHubToken.mockImplementation(async () => "repo-token");
  spies.findPullRequest.mockImplementation(async () => null);
});

describe("archiveSession", () => {
  test("clears runtime sandbox state when archive finalization fails", async () => {
    const { archiveSession } = await archiveSessionModulePromise;

    let backgroundTask: Promise<void> | null = null;

    const result = await archiveSession("session-1", {
      logPrefix: "[Test]",
      scheduleBackgroundWork: (callback) => {
        backgroundTask = callback();
      },
    });

    expect(result.archiveTriggered).toBe(true);
    if (!backgroundTask) {
      throw new Error("Expected archive finalization task to be scheduled");
    }
    await backgroundTask;

    const updateCalls = spies.updateSession.mock.calls as Array<
      [string, Record<string, unknown>]
    >;

    expect(updateCalls).toHaveLength(2);
    const recoveryPatch = updateCalls[1]?.[1];

    expect(recoveryPatch).toMatchObject({
      lifecycleState: "archived",
      sandboxExpiresAt: null,
      hibernateAfter: null,
      lifecycleError: "Archive finalization failed: sandbox connection failed",
      sandboxState: {
        type: "docker",
        sandboxName: "session_session-1",
      },
    });

    expect(sessionRecord?.sandboxState).toEqual({
      type: "docker",
      sandboxName: "session_session-1",
    });
  });

  test("refreshes merged PR status before archiving", async () => {
    const { archiveSession } = await archiveSessionModulePromise;

    sandboxQueue = [createMockSandbox(), createMockSandbox()];
    spies.findPullRequest.mockImplementation(async () => ({
      number: 7,
      state: "merged",
    }));

    let backgroundTask: Promise<void> | null = null;

    const result = await archiveSession("session-1", {
      logPrefix: "[Test]",
      scheduleBackgroundWork: (callback) => {
        backgroundTask = callback();
      },
    });

    expect(result.archiveTriggered).toBe(true);
    if (!backgroundTask) {
      throw new Error("Expected archive finalization task to be scheduled");
    }
    await backgroundTask;

    const updateCalls = spies.updateSession.mock.calls as Array<
      [string, Record<string, unknown>]
    >;

    expect(updateCalls[0]?.[1]).toMatchObject({
      status: "archived",
      prStatus: "merged",
    });
    // One lookup answers both "is there a pull request" and "what state is it
    // in" now; the App path needed a status call and a search call.
    expect(spies.findPullRequest).toHaveBeenCalledTimes(1);
    expect(sessionRecord?.prStatus).toBe("merged");
  });
});
