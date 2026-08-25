import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface SessionRow {
  id: string;
  sandboxState: { sandboxName: string; hostWorkspace: string } | null;
}

let sessions: SessionRow[] = [];
let existingChatIds = new Set<string>();
let candidatesOnDisk = new Map<
  string,
  Array<{ chatId: string; index: 1 | 2 | 3 }>
>();
let workspaceDirs: Array<{ name: string; path: string }> = [];
let syncCalls = 0;
let syncFails = false;
const removedCandidates: Array<{ sessionWorkspace: string; chatId: string }> =
  [];
const stoppedForSandbox: Array<{
  sandboxName: string;
  indexes: readonly number[];
}> = [];

mock.module("@paco/sandbox", () => ({
  workspaceRoot: () => "/workspaces",
}));

mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: (state: { hostWorkspace?: string }) => {
    if (!state.hostWorkspace) {
      throw new Error("no workspace");
    }
    return state.hostWorkspace;
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionsWithActiveSandbox: async () => sessions,
  getChatById: async (chatId: string) =>
    existingChatIds.has(chatId) ? { id: chatId } : undefined,
}));

mock.module("@/lib/design/candidates", () => ({
  listCandidateWorktrees: async (workspace: string) =>
    (candidatesOnDisk.get(workspace) ?? []).map((candidate) => ({
      ...candidate,
      worktreeDir: `${workspace}/designs/${candidate.chatId}/${candidate.index}`,
    })),
  removeCandidates: async (params: {
    sessionWorkspace: string;
    chatId: string;
  }) => {
    removedCandidates.push(params);
  },
}));

mock.module("@/lib/reaping/measure-disk", () => ({
  listWorkspaceDirectories: async () => workspaceDirs,
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: (state: unknown) => state !== null,
}));

mock.module("./candidate-dev-server", () => ({
  CANDIDATE_INDEXES: [1, 2, 3] as const,
  stopCandidateDevServersForSandbox: async (params: {
    sandboxState: { sandboxName: string };
    indexes?: readonly (1 | 2 | 3)[];
  }) => {
    stoppedForSandbox.push({
      sandboxName: params.sandboxState.sandboxName,
      indexes: params.indexes ?? [1, 2, 3],
    });
    return new Map((params.indexes ?? []).map((index) => [index, "stopped"]));
  },
}));

mock.module("./nginx-reload", () => ({
  syncPreviewRoutes: async () => {
    syncCalls++;
    if (syncFails) {
      throw new Error("nginx -t failed");
    }
  },
}));

const {
  reapOrphanedCandidateDevServers,
  reclaimOrphanedCandidateWorktrees,
  reconcilePreviewState,
  startPreviewReconciliation,
  stopPreviewReconciliation,
} = await import("./reconcile-job");

beforeEach(() => {
  sessions = [];
  existingChatIds = new Set();
  candidatesOnDisk = new Map();
  workspaceDirs = [];
  syncCalls = 0;
  syncFails = false;
  removedCandidates.length = 0;
  stoppedForSandbox.length = 0;
  stopPreviewReconciliation();
});

describe("reapOrphanedCandidateDevServers", () => {
  test("only reclaims ports whose candidate worktree is gone", async () => {
    sessions = [
      {
        id: "s1",
        sandboxState: { sandboxName: "sbx1", hostWorkspace: "/workspaces/s1" },
      },
    ];
    // Candidate 1 is live; 2 and 3 are not.
    candidatesOnDisk.set("/workspaces/s1", [{ chatId: "c1", index: 1 }]);

    await reapOrphanedCandidateDevServers();

    expect(stoppedForSandbox).toEqual([
      { sandboxName: "sbx1", indexes: [2, 3] },
    ]);
  });

  test("never touches a session whose candidates are all live", async () => {
    sessions = [
      {
        id: "s1",
        sandboxState: { sandboxName: "sbx1", hostWorkspace: "/workspaces/s1" },
      },
    ];
    candidatesOnDisk.set("/workspaces/s1", [
      { chatId: "c1", index: 1 },
      { chatId: "c1", index: 2 },
      { chatId: "c1", index: 3 },
    ]);

    await reapOrphanedCandidateDevServers();

    expect(stoppedForSandbox).toEqual([]);
  });

  test("skips a session whose workspace cannot be resolved", async () => {
    sessions = [{ id: "s1", sandboxState: { sandboxName: "sbx1" } as never }];

    await expect(reapOrphanedCandidateDevServers()).resolves.toBe(0);
    expect(stoppedForSandbox).toEqual([]);
  });
});

describe("reclaimOrphanedCandidateWorktrees", () => {
  test("removes candidates whose chat row is gone", async () => {
    workspaceDirs = [{ name: "s1", path: "/workspaces/s1" }];
    candidatesOnDisk.set("/workspaces/s1", [
      { chatId: "deleted", index: 1 },
      { chatId: "deleted", index: 2 },
    ]);

    const sweep = await reclaimOrphanedCandidateWorktrees();

    expect(sweep).toEqual({ scanned: 2, reclaimed: 2, retained: 0 });
    expect(removedCandidates).toEqual([
      { sessionWorkspace: "/workspaces/s1", chatId: "deleted" },
    ]);
  });

  test("leaves candidates belonging to a live chat alone", async () => {
    // They may hold the only copy of a design the user asked for. The Discard
    // control is the honest way out, not a background sweep.
    workspaceDirs = [{ name: "s1", path: "/workspaces/s1" }];
    existingChatIds = new Set(["live"]);
    candidatesOnDisk.set("/workspaces/s1", [{ chatId: "live", index: 1 }]);

    const sweep = await reclaimOrphanedCandidateWorktrees();

    expect(sweep).toEqual({ scanned: 1, reclaimed: 0, retained: 1 });
    expect(removedCandidates).toEqual([]);
  });

  test("scans archived and session-less workspaces too, where orphans hide best", async () => {
    workspaceDirs = [
      { name: "s1", path: "/workspaces/s1" },
      { name: "s2", path: "/workspaces/s2" },
    ];
    candidatesOnDisk.set("/workspaces/s2", [{ chatId: "gone", index: 3 }]);
    // s2 has no session row at all, so `getSessionsWithActiveSandbox` never
    // names it — the case whole-workspace reaping cannot see inside.
    sessions = [];

    const sweep = await reclaimOrphanedCandidateWorktrees();

    expect(sweep.reclaimed).toBe(1);
    expect(removedCandidates).toEqual([
      { sessionWorkspace: "/workspaces/s2", chatId: "gone" },
    ]);
  });
});

describe("reconcilePreviewState", () => {
  test("syncs preview routes every sweep", async () => {
    await reconcilePreviewState();
    expect(syncCalls).toBe(1);
  });

  test("a failing nginx sync never stops the rest of the sweep", async () => {
    syncFails = true;
    workspaceDirs = [{ name: "s1", path: "/workspaces/s1" }];
    candidatesOnDisk.set("/workspaces/s1", [{ chatId: "deleted", index: 1 }]);

    await reconcilePreviewState();

    expect(removedCandidates).toHaveLength(1);
  });
});

describe("startPreviewReconciliation", () => {
  test("starting twice schedules one sweep, not two", () => {
    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals++;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      startPreviewReconciliation();
      startPreviewReconciliation();
      expect(intervals).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      stopPreviewReconciliation();
    }
  });

  test("stopping leaves nothing scheduled, so a restart works", () => {
    startPreviewReconciliation();
    stopPreviewReconciliation();

    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals++;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      startPreviewReconciliation();
      expect(intervals).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      stopPreviewReconciliation();
    }
  });
});
