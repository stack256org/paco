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

const { classifyPreviewStack, collectActivePreviewRoutes } =
  await import("./nginx-reload");

const BASE_DOMAIN = "previews.example.com";

async function makeWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "paco-nginx-reload-test-"));
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

  test("emits one route per session, for its most recent chat", async () => {
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

  test("a session with no chats yet contributes no route", async () => {
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

  test("sandbox state with no resolvable workspace still keeps the chat's own route", async () => {
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

describe("classifyPreviewStack", () => {
  test("no nginx binary means this host has no preview stack at all", () => {
    // A development checkout, or macOS. `/etc/paco/nginx` is missing for the
    // same reason the binary is: nothing ever installed the package here.
    const status = classifyPreviewStack({
      nginxBinary: false,
      confDir: false,
    });

    expect(status.kind).toBe("not-installed");
    expect(status.kind === "not-installed" && status.reason).toContain(
      "/usr/sbin/nginx",
    );
  });

  test("a leftover config directory with no nginx is still 'not installed'", () => {
    // An uninstall that left `/etc/paco` behind, or a developer who created
    // it by hand. Without an nginx to reload, there is nothing to reconcile.
    expect(
      classifyPreviewStack({ nginxBinary: false, confDir: true }).kind,
    ).toBe("not-installed");
  });

  test("nginx present but Paco's config directory missing is a broken install", () => {
    // `postinst` creates `/etc/paco/nginx`; nginx being here without it means
    // the package is half-installed, which is a fault, not an environment.
    const status = classifyPreviewStack({ nginxBinary: true, confDir: false });

    expect(status.kind).toBe("incomplete");
    expect(status.kind === "incomplete" && status.reason).toContain(
      "/etc/paco/nginx",
    );
  });

  test("both present is ready — every failure past this point is a real fault", () => {
    // Deliberately says nothing about whether the directory is *writable*: a
    // root-owned `/etc/paco/nginx` is a broken packaged install, and it has to
    // fail loudly on every sweep rather than be classified away as "this
    // environment has no previews".
    expect(classifyPreviewStack({ nginxBinary: true, confDir: true })).toEqual({
      kind: "ready",
    });
  });
});
