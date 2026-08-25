import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface FakeSandboxState {
  hostWorkspace?: string;
  sandboxName?: string;
}

interface FakeSession {
  id: string;
  sandboxState: FakeSandboxState;
}

interface FakeChat {
  id: string;
}

let sessions: FakeSession[];
let chatsBySession: Map<string, FakeChat[]>;
/** container name -> host port, keyed again by which container port was asked for. */
let portsByContainerPort: Map<number, Map<string, number>>;

mock.module("@/lib/db/sessions", () => ({
  getSessionsWithActiveSandbox: async () => sessions,
  getChatsBySessionId: async (sessionId: string) =>
    chatsBySession.get(sessionId) ?? [],
}));

mock.module("@paco/sandbox", () => ({
  listSandboxPreviewPorts: async (containerPort: number) =>
    portsByContainerPort.get(containerPort) ?? new Map<string, number>(),
  toContainerName: (sandboxName: string) => `paco-sbx-${sandboxName}`,
  // Unused by this test (hostWorkspaceFor never falls through to them when
  // `hostWorkspace` is set directly on the fake sandbox state below), but
  // `@/lib/agent/workspace-paths` imports them by name at module load time.
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
  workspaceRoot: () => "/unused",
}));

mock.module("@/lib/sandbox/utils", () => ({
  getResumableSandboxName: () => undefined,
  getSessionSandboxName: (sessionId: string) => `session-${sessionId}`,
  isSandboxActive: () => true,
}));

const { collectActivePreviewRoutes } = await import("./nginx-reload");

const BASE_DOMAIN = "previews.example.com";

async function makeWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "paco-nginx-reload-test-"));
}

async function makeCandidateDir(
  workspaceRoot: string,
  chatId: string,
  index: number,
): Promise<void> {
  await fs.mkdir(path.join(workspaceRoot, "designs", chatId, String(index)), {
    recursive: true,
  });
}

const workspaces: string[] = [];

describe("collectActivePreviewRoutes", () => {
  beforeEach(() => {
    sessions = [];
    chatsBySession = new Map();
    portsByContainerPort = new Map();
  });

  afterEach(async () => {
    await Promise.all(
      workspaces
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  test("emits only the chat's own route when no candidate worktrees exist", async () => {
    const workspaceRoot = await makeWorkspace();
    workspaces.push(workspaceRoot);

    sessions = [
      { id: "session-1", sandboxState: { hostWorkspace: workspaceRoot } },
    ];
    chatsBySession.set("session-1", [{ id: "chat-abc" }]);
    portsByContainerPort.set(
      3000,
      new Map([["paco-sbx-session-session-1", 49_213]]),
    );

    const routes = await collectActivePreviewRoutes(BASE_DOMAIN);

    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({
      hostname: `chat-abc.${BASE_DOMAIN}`,
      upstreamPort: 49_213,
    });
  });

  test("adds a candidate route for each live candidate worktree with a published port", async () => {
    const workspaceRoot = await makeWorkspace();
    workspaces.push(workspaceRoot);
    await makeCandidateDir(workspaceRoot, "chat-abc", 1);
    await makeCandidateDir(workspaceRoot, "chat-abc", 3);

    sessions = [
      { id: "session-1", sandboxState: { hostWorkspace: workspaceRoot } },
    ];
    chatsBySession.set("session-1", [{ id: "chat-abc" }]);

    const containerName = "paco-sbx-session-session-1";
    portsByContainerPort.set(3000, new Map([[containerName, 49_213]]));
    // candidateContainerPort(1) === 5173, candidateContainerPort(3) === 8000
    portsByContainerPort.set(5173, new Map([[containerName, 51_731]]));
    portsByContainerPort.set(8000, new Map([[containerName, 58_001]]));

    const routes = await collectActivePreviewRoutes(BASE_DOMAIN);

    const hostnames = routes.map((route) => route.hostname).sort();
    expect(hostnames).toEqual(
      [
        `chat-abc.${BASE_DOMAIN}`,
        `chat-abc-d1.${BASE_DOMAIN}`,
        `chat-abc-d3.${BASE_DOMAIN}`,
      ].sort(),
    );

    const candidate1 = routes.find(
      (route) => route.hostname === `chat-abc-d1.${BASE_DOMAIN}`,
    );
    expect(candidate1?.upstreamPort).toBe(51_731);
    expect(candidate1?.isDesignCandidate).toBe(true);

    const candidate3 = routes.find(
      (route) => route.hostname === `chat-abc-d3.${BASE_DOMAIN}`,
    );
    expect(candidate3?.upstreamPort).toBe(58_001);
    expect(candidate3?.isDesignCandidate).toBe(true);

    // Candidate 2 has no worktree directory at all — never even considered.
    expect(
      routes.some((route) => route.hostname === `chat-abc-d2.${BASE_DOMAIN}`),
    ).toBe(false);

    // The chat's own route is never marked as a candidate.
    const chatRoute = routes.find(
      (route) => route.hostname === `chat-abc.${BASE_DOMAIN}`,
    );
    expect(chatRoute?.isDesignCandidate).toBeUndefined();
  });

  test("skips a candidate worktree whose dev server has not published its port yet", async () => {
    const workspaceRoot = await makeWorkspace();
    workspaces.push(workspaceRoot);
    await makeCandidateDir(workspaceRoot, "chat-abc", 2);

    sessions = [
      { id: "session-1", sandboxState: { hostWorkspace: workspaceRoot } },
    ];
    chatsBySession.set("session-1", [{ id: "chat-abc" }]);

    const containerName = "paco-sbx-session-session-1";
    portsByContainerPort.set(3000, new Map([[containerName, 49_213]]));
    // candidateContainerPort(2) === 4321 — deliberately left unpublished.

    const routes = await collectActivePreviewRoutes(BASE_DOMAIN);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.hostname).toBe(`chat-abc.${BASE_DOMAIN}`);
  });

  test("a session with no chats yet has no candidate routes either", async () => {
    const workspaceRoot = await makeWorkspace();
    workspaces.push(workspaceRoot);

    sessions = [
      { id: "session-1", sandboxState: { hostWorkspace: workspaceRoot } },
    ];
    chatsBySession.set("session-1", []);
    portsByContainerPort.set(
      3000,
      new Map([["paco-sbx-session-session-1", 49_213]]),
    );

    const routes = await collectActivePreviewRoutes(BASE_DOMAIN);

    expect(routes).toHaveLength(0);
  });

  test("sandbox state with no resolvable workspace skips candidates but keeps the chat's own route", async () => {
    sessions = [{ id: "session-1", sandboxState: {} }];
    chatsBySession.set("session-1", [{ id: "chat-abc" }]);
    portsByContainerPort.set(
      3000,
      new Map([["paco-sbx-session-session-1", 49_213]]),
    );

    const routes = await collectActivePreviewRoutes(BASE_DOMAIN);

    expect(routes).toHaveLength(1);
    expect(routes[0]?.hostname).toBe(`chat-abc.${BASE_DOMAIN}`);
  });
});
