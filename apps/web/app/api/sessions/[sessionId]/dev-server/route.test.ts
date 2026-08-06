import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NO_PACKAGE_MANAGER_MESSAGE } from "./_lib/package-manager-fallback";

mock.module("server-only", () => ({}));

/*
 * Paco's bookkeeping lives under /tmp, keyed by the workspace path — not beside
 * the user's code, where these two files showed up in the Changes tab and would
 * have been committed to their repository by "Commit & Push".
 */
const runtimeDir = (dir: string) =>
  `/tmp/paco-dev-server/${Buffer.from(dir).toString("base64url")}`;

const DEV_SERVER_PID_FILE = `${runtimeDir("/workspace/apps/web")}/.paco-dev-server-3000.pid`;
const DEV_SERVER_LOG_FILE = `${runtimeDir("/workspace/apps/web")}/.paco-dev-server-3000.log`;
const DEV_SERVER_STATE_FILE = `${runtimeDir("/workspace")}/.paco-dev-server-state.json`;
const RUNNING_PID = "4242";

const currentSessionRecord = {
  userId: "user-1",
  sandboxState: {
    type: "docker" as const,
    sandboxId: "sandbox-1",
    expiresAt: Date.now() + 60_000,
  },
};

type MockPathEntry = {
  type: "file" | "directory";
  mtimeMs: number;
  size: number;
};

let currentFindOutput = "./package.json\n./apps/web/package.json\n";
let fileContents = new Map<string, string>();
let existingPaths = new Set<string>();
let pathEntries = new Map<string, MockPathEntry>();
let runningPids = new Set<string>();
let lastLaunchCommand: string | null = null;
let lastLaunchCwd: string | null = null;
let currentMtimeMs = 1_000;

function successResult(stdout = "") {
  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    truncated: false,
  };
}

function failureResult(stderr: string) {
  return {
    success: false,
    exitCode: 1,
    stdout: "",
    stderr,
    truncated: false,
  };
}

function nextMtime(): number {
  currentMtimeMs += 100;
  return currentMtimeMs;
}

function setMockFile(filePath: string, content: string, mtimeMs = nextMtime()) {
  fileContents.set(filePath, content);
  existingPaths.add(filePath);
  pathEntries.set(filePath, {
    type: "file",
    mtimeMs,
    size: content.length,
  });
}

function setMockDirectory(dirPath: string, mtimeMs = nextMtime()) {
  existingPaths.add(dirPath);
  pathEntries.set(dirPath, {
    type: "directory",
    mtimeMs,
    size: 0,
  });
}

function removeMockPath(targetPath: string) {
  existingPaths.delete(targetPath);
  fileContents.delete(targetPath);
  pathEntries.delete(targetPath);
}

function seedDefaultWorkspace() {
  currentFindOutput = "./package.json\n./apps/web/package.json\n";

  setMockDirectory("/workspace");
  setMockDirectory("/workspace/apps");
  setMockDirectory("/workspace/apps/web");

  setMockFile(
    "/workspace/package.json",
    JSON.stringify({
      packageManager: "bun@1.2.14",
      scripts: {
        dev: "turbo dev",
      },
    }),
  );
  setMockFile(
    "/workspace/apps/web/package.json",
    JSON.stringify({
      scripts: {
        dev: "next dev",
      },
      dependencies: {
        next: "15.0.0",
      },
    }),
  );
  setMockFile("/workspace/bun.lock", "");
}

const requireAuthenticatedUserMock = mock(async () => ({
  ok: true as const,
  userId: "user-1",
}));
const requireOwnedSessionWithSandboxGuardMock = mock(async () => ({
  ok: true as const,
  sessionRecord: currentSessionRecord,
}));
const execMock = mock(async (command: string) => {
  if (command.includes("find .")) {
    return successResult(currentFindOutput);
  }

  if (command.startsWith("kill -0 ")) {
    const pid = command.slice("kill -0 ".length).trim();
    return runningPids.has(pid)
      ? successResult()
      : failureResult(`No such process: ${pid}`);
  }

  if (command.startsWith("kill ")) {
    const pid = command.match(/^kill ([0-9]+)/)?.[1];
    if (pid) {
      runningPids.delete(pid);
    }
    return successResult();
  }

  if (command.startsWith("rm -f ")) {
    const filePath = command.match(/^rm -f '(.+)'$/)?.[1];
    if (filePath) {
      removeMockPath(filePath);
    }
    return successResult();
  }

  /*
   * Paco's own bookkeeping under /tmp goes through `exec`, not the file API:
   * those paths are outside the workspace, which the file API refuses. See
   * lib/sandbox/runtime-files.
   */
  {
    const mkdirOnly = command.match(/^mkdir -p '([^']+)'$/);
    if (mkdirOnly) {
      setMockDirectory(mkdirOnly[1]);
      return successResult();
    }

    const write = command.match(
      /^mkdir -p '([^']+)' && printf '%s' '([^']*)' \| base64 -d > '([^']+)'$/,
    );
    if (write) {
      setMockDirectory(write[1]);
      setMockFile(write[3], Buffer.from(write[2], "base64").toString("utf-8"));
      return successResult();
    }

    const read = command.match(/^cat '([^']+)' 2>\/dev\/null$/);
    if (read) {
      const content = fileContents.get(read[1]);
      return content === undefined
        ? { success: false, stdout: "", stderr: "" }
        : successResult(content);
    }

    // Reading back what the dev server printed before it died.
    const tail = command.match(/^tail -n \d+ '([^']+)' 2>\/dev\/null$/);
    if (tail) {
      return successResult(fileContents.get(tail[1]) ?? "");
    }
  }

  /*
   * Port probes, both of which read /proc rather than shelling out to `ss` or
   * `lsof` — neither is installed in the sandbox image. Nothing is listening in
   * these tests unless a case says otherwise.
   */
  if (command.startsWith("inode=$(awk")) {
    // findDevServerPidByPort: prints the owning pid, or nothing.
    return (
      listeningPortPids.get(extractProbedPort(command)) ?? successResult("")
    );
  }

  if (
    command.startsWith("awk -v p=") &&
    command.includes("END {exit !found}")
  ) {
    // isPortListening: exit status is the answer.
    const probedPort = extractProbedPort(command);
    const listening =
      stubbornPort === probedPort || listeningPortPids.has(probedPort);
    return listening
      ? successResult("")
      : { success: false, stdout: "", stderr: "" };
  }

  // Killing the dev server's process group.
  if (command.startsWith("pgid=$(ps -o pgid=")) {
    const pid = command.match(/-p (\d+)/)?.[1];
    if (pid) {
      runningPids.delete(pid);
      for (const [port, result] of listeningPortPids) {
        if (result.stdout.trim() === pid) {
          listeningPortPids.delete(port);
        }
      }
    }
    return successResult();
  }

  /*
   * "Is this package manager installed?"
   *
   * The default set mirrors the real `paco-sandbox:latest`, checked by running
   * `command -v` for each manager inside it: npm, pnpm and yarn are present and
   * bun is not. A test that wants a different image overrides
   * `installedPackageManagers`.
   */
  {
    const probed = command.match(/^command -v '([^']+)'$/);
    if (probed) {
      return installedPackageManagers.has(probed[1])
        ? successResult(`/usr/local/bin/${probed[1]}`)
        : { success: false, stdout: "", stderr: "" };
    }
  }

  throw new Error(`Unexpected exec command: ${command}`);
});
const readFileMock = mock(async (filePath: string) => {
  const content = fileContents.get(filePath);
  if (content === undefined) {
    throw new Error(`Missing file: ${filePath}`);
  }
  return content;
});
const writeFileMock = mock(async (filePath: string, content: string) => {
  setMockFile(filePath, content);
});
const statMock = mock(async (filePath: string) => {
  const entry = pathEntries.get(filePath);
  if (!entry) {
    throw new Error(`ENOENT: ${filePath}`);
  }

  return {
    isDirectory: () => entry.type === "directory",
    isFile: () => entry.type === "file",
    size: entry.size,
    mtimeMs: entry.mtimeMs,
  };
});
const accessMock = mock(async (filePath: string) => {
  if (!existingPaths.has(filePath)) {
    throw new Error(`ENOENT: ${filePath}`);
  }
});
const execDetachedMock = mock(async (command: string, cwd: string) => {
  lastLaunchCommand = command;
  lastLaunchCwd = cwd;

  const pidFilePath = command.match(
    /> '([^']+\.paco-dev-server-[0-9]+\.pid)'/,
  )?.[1];
  if (pidFilePath) {
    setMockFile(pidFilePath, `${RUNNING_PID}\n`);
    runningPids.add(RUNNING_PID);
  }

  return { commandId: "cmd-1" };
});
const mkdirMock = mock(async () => undefined);

/** Ports a test wants to pretend are already serving, keyed by port number. */
const listeningPortPids = new Map<number, ReturnType<typeof successResult>>();
/** A port that keeps answering no matter what is killed. */
let stubbornPort: number | null = null;

/**
 * Which package managers the workspace image provides.
 *
 * Defaults to what `paco-sandbox:latest` really contains — bun is deliberately
 * absent, which is the condition that used to make a bun project report itself
 * as running over a port nothing was listening on.
 */
let installedPackageManagers = new Set(["npm", "pnpm", "yarn"]);

function extractProbedPort(command: string): number {
  // The /proc probes match on the port in hex, as /proc/net/tcp writes it.
  const hex = /p=":([0-9A-F]{4})"/.exec(command);
  if (hex) {
    return Number.parseInt(hex[1], 16);
  }

  const match = /:\s*(\d+)/.exec(command);
  return match ? Number(match[1]) : 0;
}
const domainMock = mock((port: number) => `http://localhost:${port}`);
const connectSandboxMock = mock(async () => ({
  workingDirectory: "/workspace",
  exec: execMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
  stat: statMock,
  access: accessMock,
  execDetached: execDetachedMock,
  domain: domainMock,
}));

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
  requireAuthenticatedUser: requireAuthenticatedUserMock,
  requireOwnedSessionWithSandboxGuard: requireOwnedSessionWithSandboxGuardMock,
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: connectSandboxMock,
}));

const routeModulePromise = import("./route");

function createRouteContext(sessionId = "session-1") {
  return {
    params: Promise.resolve({ sessionId }),
  };
}

describe("/api/sessions/[sessionId]/dev-server", () => {
  beforeEach(() => {
    currentMtimeMs = 1_000;
    fileContents = new Map();
    existingPaths = new Set<string>();
    pathEntries = new Map<string, MockPathEntry>();
    seedDefaultWorkspace();
    runningPids = new Set<string>();
    lastLaunchCommand = null;
    lastLaunchCwd = null;
    currentSessionRecord.sandboxState.expiresAt = Date.now() + 60_000;
    requireAuthenticatedUserMock.mockClear();
    requireOwnedSessionWithSandboxGuardMock.mockClear();
    connectSandboxMock.mockClear();
    execMock.mockClear();
    readFileMock.mockClear();
    writeFileMock.mockClear();
    mkdirMock.mockClear();
    listeningPortPids.clear();
    stubbornPort = null;
    installedPackageManagers = new Set(["npm", "pnpm", "yarn"]);
    statMock.mockClear();
    accessMock.mockClear();
    execDetachedMock.mockClear();
    domainMock.mockClear();
  });

  test("prefers a direct app dev script over a root workspace orchestrator and returns its preview URL", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      packagePath: string;
      port: number;
      url: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      packagePath: "apps/web",
      port: 3000,
      url: "http://localhost:3000",
    });
    expect(connectSandboxMock).toHaveBeenCalledWith(
      currentSessionRecord.sandboxState,
      { ports: [3000, 5173, 4321, 8000] },
    );
    expect(execDetachedMock).toHaveBeenCalledTimes(1);
    expect(lastLaunchCwd).toBe("/workspace/apps/web");
    expect(lastLaunchCommand).not.toBeNull();
    expect(existingPaths.has(DEV_SERVER_PID_FILE)).toBe(true);
    expect(existingPaths.has(DEV_SERVER_STATE_FILE)).toBe(true);
    expect(fileContents.get(DEV_SERVER_STATE_FILE)).toBe(
      JSON.stringify({ packageDir: "apps/web", port: 3000 }),
    );
    expect(runningPids.has(RUNNING_PID)).toBe(true);

    if (!lastLaunchCommand) {
      throw new Error("Expected execDetached to receive a launch command");
    }

    expect(lastLaunchCommand).toContain(DEV_SERVER_PID_FILE);
    // The workspace declares `packageManager: "bun@1.2.14"`, and the image has
    // no bun, so the launch falls back rather than running a command that does
    // not exist. See _lib/package-manager-fallback.
    expect(lastLaunchCommand).toContain("pnpm install");
    expect(lastLaunchCommand).toContain("pnpm dev");
    expect(lastLaunchCommand).toContain("--hostname 0.0.0.0 --port 3000");
  });

  test("uses the project's own package manager when the image provides it", async () => {
    const { POST } = await routeModulePromise;
    installedPackageManagers = new Set(["npm", "pnpm", "yarn", "bun"]);

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    expect(response.status).toBe(200);
    expect(lastLaunchCommand).toContain("bun install");
    expect(lastLaunchCommand).toContain("bun run dev");
  });

  test("refuses rather than launching a command that cannot exist", async () => {
    const { POST } = await routeModulePromise;
    installedPackageManagers = new Set<string>();

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    // Launching regardless is what produced a permanently "running" panel over
    // a port nothing was listening on, with the reason discarded to /dev/null.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: NO_PACKAGE_MANAGER_MESSAGE,
    });
    expect(lastLaunchCommand).toBeNull();
  });

  test("kills the whole process group, not just the recorded pid", async () => {
    /*
     * The recorded pid is the shell that execs the package manager; the server
     * itself is a grandchild (`pnpm dev` -> `vite` -> esbuild). Killing the one
     * pid left the server holding the port, reparented to init, while Stop
     * reported success — so a second Start stacked another orphan on top.
     */
    const { DELETE, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "DELETE",
      }),
      createRouteContext(),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { stopped: boolean }).stopped).toBe(
      true,
    );

    const killCommands = execMock.mock.calls
      .map(([command]) => command as string)
      .filter((command) => command.includes("kill -"));

    expect(killCommands.length).toBeGreaterThan(0);
    // `kill -TERM -$pgid` — the leading dash on the target is the whole group.
    expect(killCommands.some((c) => c.includes('kill -TERM -"$pgid"'))).toBe(
      true,
    );
  });

  test("reports failure when the port is still served after the kill", async () => {
    // Reporting "stopped" while something still holds the port is how the UI
    // ended up disagreeing with the container.
    const { DELETE, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    // A server that ignores the kill: the port keeps answering throughout.
    stubbornPort = 3000;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "DELETE",
      }),
      createRouteContext(),
    );

    expect(((await response.json()) as { stopped: boolean }).stopped).toBe(
      false,
    );
  }, 10_000);

  test("keeps the persisted target when the stop failed", async () => {
    /*
     * `stopDevServer` deliberately leaves the pid file alone when the process
     * survives, "so the next call has something to work with". Clearing the
     * persisted target unconditionally threw away the other half of that
     * record, so the surviving server was no longer addressable and Stop could
     * never finish the job.
     */
    const { DELETE, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    expect(existingPaths.has(DEV_SERVER_STATE_FILE)).toBe(true);

    stubbornPort = 3000;

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "DELETE",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      stopped: boolean;
      packagePath: string;
    };

    expect(body.stopped).toBe(false);
    // Answered about the app that was actually launched, not whatever package
    // discovery would pick now.
    expect(body.packagePath).toBe("apps/web");
    expect(existingPaths.has(DEV_SERVER_STATE_FILE)).toBe(true);
  }, 10_000);

  test("does not put a -- separator in front of the pnpm dev flags", async () => {
    // pnpm 11 passes `--` to the script verbatim instead of consuming it, so
    // `pnpm dev -- --host 0.0.0.0 --port 5173` ran
    // `vite -- --host 0.0.0.0 --port 5173`. Vite reads everything after `--`
    // as positional, ignored both flags, and bound to localhost inside the
    // container — the dev server started and its published URL was dead.
    const { POST } = await routeModulePromise;

    // Replace the default bun monorepo with a single pnpm app.
    removeMockPath("/workspace/bun.lock");
    removeMockPath("/workspace/apps/web/package.json");
    currentFindOutput = "./package.json\n";
    setMockDirectory("/workspace");
    setMockFile(
      "/workspace/package.json",
      JSON.stringify({
        packageManager: "pnpm@11.18.0",
        scripts: { dev: "vite" },
        dependencies: { vite: "5.4.21" },
      }),
    );
    setMockFile("/workspace/pnpm-lock.yaml", "");

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    expect(response.status).toBe(200);

    if (!lastLaunchCommand) {
      throw new Error("Expected execDetached to receive a launch command");
    }

    expect(lastLaunchCommand).toContain("pnpm dev");
    expect(lastLaunchCommand).not.toContain("pnpm dev -- ");
    expect(lastLaunchCommand).toContain("--host 0.0.0.0");
  });

  test("returns the existing preview URL without relaunching when the dev server is already running", async () => {
    const { POST } = await routeModulePromise;

    setMockFile(DEV_SERVER_PID_FILE, `${RUNNING_PID}\n`);
    setMockFile(
      DEV_SERVER_STATE_FILE,
      JSON.stringify({ packageDir: "apps/web", port: 3000 }),
    );
    runningPids.add(RUNNING_PID);

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      packagePath: string;
      port: number;
      url: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      packagePath: "apps/web",
      port: 3000,
      url: "http://localhost:3000",
    });
    expect(execDetachedMock).toHaveBeenCalledTimes(0);
  });

  test("keeps using the launched app when package discovery later prefers another app", async () => {
    const { POST } = await routeModulePromise;

    const firstResponse = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    expect(firstResponse.status).toBe(200);

    setMockDirectory("/workspace/apps/admin");
    setMockFile(
      "/workspace/apps/admin/package.json",
      JSON.stringify({
        scripts: {
          dev: "next dev",
        },
        dependencies: {
          next: "15.0.0",
        },
      }),
    );
    currentFindOutput =
      "./apps/admin/package.json\n./apps/web/package.json\n./package.json\n";

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      packagePath: string;
      port: number;
      url: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      packagePath: "apps/web",
      port: 3000,
      url: "http://localhost:3000",
    });
    expect(execDetachedMock).toHaveBeenCalledTimes(1);
  });

  test("stops the running dev server even when package discovery later prefers another app", async () => {
    const { DELETE, POST } = await routeModulePromise;

    const launchResponse = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    expect(launchResponse.status).toBe(200);

    setMockDirectory("/workspace/apps/admin");
    setMockFile(
      "/workspace/apps/admin/package.json",
      JSON.stringify({
        scripts: {
          dev: "next dev",
        },
        dependencies: {
          next: "15.0.0",
        },
      }),
    );
    currentFindOutput =
      "./apps/admin/package.json\n./apps/web/package.json\n./package.json\n";

    const response = await DELETE(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "DELETE",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      stopped: boolean;
      packagePath: string;
      port: number;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      stopped: true,
      packagePath: "apps/web",
      port: 3000,
    });
    expect(runningPids.has(RUNNING_PID)).toBe(false);
    expect(existingPaths.has(DEV_SERVER_PID_FILE)).toBe(false);
    expect(existingPaths.has(DEV_SERVER_STATE_FILE)).toBe(false);
  });

  test("reinstalls dependencies when a package manifest changed after node_modules was created", async () => {
    const { POST } = await routeModulePromise;

    setMockDirectory("/workspace/node_modules", 5_000);
    setMockFile(
      "/workspace/apps/web/package.json",
      JSON.stringify({
        scripts: {
          dev: "next dev",
        },
        dependencies: {
          next: "15.0.0",
          react: "19.0.0",
        },
      }),
      6_000,
    );

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    expect(response.status).toBe(200);
    expect(lastLaunchCommand).not.toBeNull();

    if (!lastLaunchCommand) {
      throw new Error("Expected execDetached to receive a launch command");
    }

    expect(lastLaunchCommand).toContain("pnpm install");
  });

  test("skips dependency install when node_modules is newer than manifests and lockfiles", async () => {
    const { POST } = await routeModulePromise;

    setMockDirectory("/workspace/node_modules", 10_000);

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    expect(response.status).toBe(200);
    expect(lastLaunchCommand).not.toBeNull();

    if (!lastLaunchCommand) {
      throw new Error("Expected execDetached to receive a launch command");
    }

    expect(lastLaunchCommand).not.toContain("bun install");
  });

  test("returns 404 when no supported dev script is found", async () => {
    const { POST } = await routeModulePromise;

    fileContents = new Map();
    existingPaths = new Set<string>();
    pathEntries = new Map<string, MockPathEntry>();
    setMockDirectory("/workspace");
    setMockFile(
      "/workspace/package.json",
      JSON.stringify({
        scripts: {
          test: "bun test",
        },
      }),
    );
    currentFindOutput = "./package.json\n";

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe(
      "We couldn't find a dev server to start in this project.",
    );
    expect(execDetachedMock).toHaveBeenCalledTimes(0);
  });

  test("captures everything the dev server prints, in a file of its own", async () => {
    const { POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    if (!lastLaunchCommand) {
      throw new Error("Expected execDetached to receive a launch command");
    }

    // Until this existed the launch ran under `docker exec -d` with its output
    // discarded, so a crash could only ever be reported as "it stopped" with no
    // way to say why.
    expect(lastLaunchCommand).toContain(`: > '${DEV_SERVER_LOG_FILE}'`);
    // The install too: a failed `pnpm install` is one of the commonest ways for
    // a preview to never appear, and its output went to /dev/null as well.
    expect(lastLaunchCommand).toContain(
      `(cd '/workspace' && pnpm install) >> '${DEV_SERVER_LOG_FILE}' 2>&1`,
    );
    expect(lastLaunchCommand).toContain(
      `pnpm dev --hostname 0.0.0.0 --port 3000 >> '${DEV_SERVER_LOG_FILE}' 2>&1`,
    );

    // `exec` has to survive: the recorded pid must *be* the dev server for the
    // process-group kill to reach it.
    expect(lastLaunchCommand).toContain("exec env ");

    // Beside the pid file under /tmp, never in the workspace — a stray
    // dev-server.log would show up in the Changes tab as the user's own work.
    expect(DEV_SERVER_LOG_FILE.startsWith("/tmp/")).toBe(true);
  });

  test("hands back the app's last words when the port has gone quiet", async () => {
    const { GET, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    // The app started, then died: the port is silent and the log holds the
    // reason. This is the state the liveness poll is built to notice.
    runningPids.delete(RUNNING_PID);
    listeningPortPids.clear();
    setMockFile(
      DEV_SERVER_LOG_FILE,
      "VITE ready in 312 ms\nSyntaxError: Unexpected token in src/App.tsx:12\n",
    );

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/dev-server?logs=1"),
      createRouteContext(),
    );
    const body = (await response.json()) as {
      running: boolean;
      lastOutput?: string;
    };

    expect(body.running).toBe(false);
    expect(body.lastOutput).toBe(
      "VITE ready in 312 ms\nSyntaxError: Unexpected token in src/App.tsx:12",
    );
  });

  test("does not read the log unless it was asked to", async () => {
    const { GET, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    runningPids.delete(RUNNING_PID);
    listeningPortPids.clear();
    setMockFile(DEV_SERVER_LOG_FILE, "installing…");

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/dev-server"),
      createRouteContext(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    // The readiness poll hits this branch every 1.5s for up to four minutes
    // while `npm install` runs, and has no use for the answer. It should not
    // pay an extra container exec for it.
    expect(body).toEqual({ running: false });
  });

  test("says nothing about output when there is none", async () => {
    const { GET, POST } = await routeModulePromise;

    await POST(
      new Request("http://localhost/api/sessions/session-1/dev-server", {
        method: "POST",
      }),
      createRouteContext(),
    );

    runningPids.delete(RUNNING_PID);
    listeningPortPids.clear();

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/dev-server?logs=1"),
      createRouteContext(),
    );

    expect(await response.json()).toEqual({ running: false });
  });
});
