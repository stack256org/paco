import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const {
  candidateListenerScript,
  isCandidateWorktreeCwd,
  parseCandidateListener,
  stopCandidateDevServers,
} = await import("./candidate-dev-server");

type Sandbox = Parameters<typeof stopCandidateDevServers>[0]["sandbox"];

interface ExecCall {
  command: string;
  cwd: string;
}

/**
 * A sandbox whose /proc probe answers from a script, so the port can "go
 * quiet" the way a killed dev server's does.
 */
function fakeSandbox(params: {
  listeners: Map<number, { pid: string; cwd: string }>;
  calls: ExecCall[];
  refuseToDie?: boolean;
}): Sandbox {
  const { listeners, calls, refuseToDie = false } = params;

  return {
    exec: async (command: string, cwd: string) => {
      calls.push({ command, cwd });

      const killMatch = command.match(/kill -(TERM|KILL) (\d+)/);
      if (killMatch && !refuseToDie) {
        for (const [port, listener] of listeners) {
          if (listener.pid === killMatch[2]) {
            listeners.delete(port);
          }
        }
        return { success: true, stdout: "", stderr: "" };
      }

      const portMatch = command.match(/p=":([0-9A-F]{4})"/);
      if (portMatch) {
        const port = Number.parseInt(portMatch[1], 16);
        const listener = listeners.get(port);
        return {
          success: true,
          stdout: listener ? `${listener.pid}\n${listener.cwd}\n` : "",
          stderr: "",
        };
      }

      return { success: true, stdout: "", stderr: "" };
    },
  } as unknown as Sandbox;
}

const WORKSPACE = "/workspaces/session_abc";

describe("parseCandidateListener", () => {
  test("reads the pid and its working directory", () => {
    expect(parseCandidateListener("4711\n/workspaces/s/designs/c/1\n")).toEqual(
      {
        pid: "4711",
        cwd: "/workspaces/s/designs/c/1",
      },
    );
  });

  test("is null when nothing was listening", () => {
    expect(parseCandidateListener("")).toBeNull();
    expect(parseCandidateListener("\n\n")).toBeNull();
  });

  test("rejects anything that is not a pid", () => {
    expect(parseCandidateListener("not-a-pid\n/tmp\n")).toBeNull();
    expect(parseCandidateListener("0\n/tmp\n")).toBeNull();
  });
});

describe("isCandidateWorktreeCwd", () => {
  test("accepts a candidate worktree and its subdirectories", () => {
    expect(
      isCandidateWorktreeCwd(`${WORKSPACE}/designs/chat1/2`, WORKSPACE),
    ).toBe(true);
    expect(
      isCandidateWorktreeCwd(
        `${WORKSPACE}/designs/chat1/2/apps/web`,
        WORKSPACE,
      ),
    ).toBe(true);
  });

  test("survives the ` (deleted)` suffix /proc adds once the worktree is gone", () => {
    // The case that matters most: the worktree was `rm -rf`'d and the dev
    // server is still holding the port.
    expect(
      isCandidateWorktreeCwd(
        `${WORKSPACE}/designs/chat1/2 (deleted)`,
        WORKSPACE,
      ),
    ).toBe(true);
  });

  test("refuses the chat's own worktree and the repo", () => {
    expect(isCandidateWorktreeCwd(`${WORKSPACE}/chats/chat1`, WORKSPACE)).toBe(
      false,
    );
    expect(isCandidateWorktreeCwd(`${WORKSPACE}/repo`, WORKSPACE)).toBe(false);
    expect(isCandidateWorktreeCwd("", WORKSPACE)).toBe(false);
  });

  test("refuses another workspace's designs directory", () => {
    expect(
      isCandidateWorktreeCwd("/workspaces/session_zzz/designs/c/1", WORKSPACE),
    ).toBe(false);
    // A sibling whose name merely starts with this workspace's name.
    expect(
      isCandidateWorktreeCwd(`${WORKSPACE}-other/designs/c/1`, WORKSPACE),
    ).toBe(false);
  });
});

describe("candidateListenerScript", () => {
  test("looks the port up in hex, as /proc/net/tcp writes it", () => {
    // 5173 = 0x1435, candidate 1's port.
    expect(candidateListenerScript(5173)).toContain('p=":1435"');
    expect(candidateListenerScript(5173)).toContain("/proc/net/tcp");
    expect(candidateListenerScript(5173)).toContain('readlink "$d/cwd"');
  });
});

describe("stopCandidateDevServers", () => {
  let calls: ExecCall[];

  beforeEach(() => {
    calls = [];
  });

  test("kills a dev server running out of a candidate worktree", async () => {
    const listeners = new Map([
      [5173, { pid: "900", cwd: `${WORKSPACE}/designs/chat1/1` }],
    ]);

    const outcomes = await stopCandidateDevServers({
      sandbox: fakeSandbox({ listeners, calls }),
      workspaceRoot: WORKSPACE,
      indexes: [1],
    });

    expect(outcomes.get(1)).toBe("stopped");
    expect(listeners.size).toBe(0);
  });

  test("leaves the chat's own dev server alone on a candidate port", async () => {
    // 5173 is an ordinary published port; the dev-server route deliberately
    // adopts a chat's server found on it. Killing that would be a data-loss
    // grade bug dressed up as cleanup.
    const listeners = new Map([
      [4321, { pid: "901", cwd: `${WORKSPACE}/chats/chat1` }],
    ]);

    const outcomes = await stopCandidateDevServers({
      sandbox: fakeSandbox({ listeners, calls }),
      workspaceRoot: WORKSPACE,
      indexes: [2],
    });

    expect(outcomes.get(2)).toBe("not-ours");
    expect(listeners.size).toBe(1);
    expect(calls.some((call) => call.command.includes("kill -"))).toBe(false);
  });

  test("reports an idle port rather than inventing a kill", async () => {
    const outcomes = await stopCandidateDevServers({
      sandbox: fakeSandbox({ listeners: new Map(), calls }),
      workspaceRoot: WORKSPACE,
      indexes: [1, 2, 3],
    });

    expect([...outcomes.values()]).toEqual(["idle", "idle", "idle"]);
  });

  test("reports failure rather than success when the process survives", async () => {
    const listeners = new Map([
      [8000, { pid: "902", cwd: `${WORKSPACE}/designs/chat1/3` }],
    ]);

    const outcomes = await stopCandidateDevServers({
      sandbox: fakeSandbox({ listeners, calls, refuseToDie: true }),
      workspaceRoot: WORKSPACE,
      indexes: [3],
    });

    expect(outcomes.get(3)).toBe("failed");
  });
});
