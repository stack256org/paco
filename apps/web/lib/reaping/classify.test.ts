import { describe, expect, test } from "bun:test";
import {
  classifyContainers,
  classifyWorkspaces,
  mayHoldUnsavedWork,
  planReclaim,
  sessionResourceNames,
  summarize,
} from "./classify";
import type {
  ContainerSnapshot,
  SessionResourceNames,
  UnsavedWork,
  WorkspaceSnapshot,
} from "./types";

function sessionRow(
  overrides: Partial<{
    id: string;
    status: string | null;
    title: string | null;
    sandboxState: unknown;
  }> = {},
) {
  return {
    id: overrides.id ?? "abc",
    status: overrides.status === undefined ? "running" : overrides.status,
    title: overrides.title ?? "A session",
    sandboxState:
      overrides.sandboxState === undefined
        ? { type: "docker", sandboxName: `session_${overrides.id ?? "abc"}` }
        : overrides.sandboxState,
  };
}

function container(
  name: string,
  overrides: Partial<ContainerSnapshot> = {},
): ContainerSnapshot {
  return {
    id: `id-${name}`,
    name,
    state: overrides.running === false ? "exited" : "running",
    running: true,
    createdAtSeconds: 1_700_000_000,
    writableBytes: 0,
    ...overrides,
  };
}

function workspace(
  name: string,
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    name,
    path: `/home/u/.paco/workspaces/${name}`,
    sizeBytes: 0,
    measured: true,
    modifiedAtMs: 0,
    unsavedWork: cleanWork(),
    ...overrides,
  };
}

function cleanWork(overrides: Partial<UnsavedWork> = {}): UnsavedWork {
  return {
    uncommittedFiles: 0,
    unpushedCommits: 0,
    hasRemote: true,
    trackedFiles: 12,
    ...overrides,
  };
}

describe("sessionResourceNames", () => {
  test("derives the container and workspace names from the session id", () => {
    expect(sessionResourceNames(sessionRow({ id: "s1" }))).toEqual({
      sessionId: "s1",
      title: "A session",
      archived: false,
      containerNames: ["paco-sbx-session_s1"],
      workspaceNames: ["session_s1"],
    });
  });

  test("keeps a persisted sandbox name that differs from the derived one", () => {
    const names = sessionResourceNames(
      sessionRow({
        id: "s1",
        sandboxState: { type: "docker", sandboxName: "legacy-name" },
      }),
    );

    expect(names.workspaceNames).toEqual(["session_s1", "legacy-name"]);
    expect(names.containerNames).toEqual([
      "paco-sbx-session_s1",
      "paco-sbx-legacy-name",
    ]);
  });

  test("still derives names when the row has no sandbox state at all", () => {
    const names = sessionResourceNames(
      sessionRow({ id: "s1", sandboxState: null }),
    );

    expect(names.workspaceNames).toEqual(["session_s1"]);
  });

  test("marks archived rows as archived, not as orphaned owners", () => {
    expect(
      sessionResourceNames(sessionRow({ status: "archived" })).archived,
    ).toBe(true);
    expect(sessionResourceNames(sessionRow({ status: null })).archived).toBe(
      false,
    );
  });
});

describe("classifyContainers", () => {
  const sessions: SessionResourceNames[] = [
    sessionResourceNames(sessionRow({ id: "live", title: "Live one" })),
    sessionResourceNames(sessionRow({ id: "old", status: "archived" })),
  ];

  test("a container with no session row is orphaned", () => {
    const [result] = classifyContainers(
      [container("paco-sbx-session_gone")],
      sessions,
    );

    expect(result?.ownership).toBe("orphaned");
    expect(result?.sessionId).toBeNull();
  });

  test("a container whose session row exists is live", () => {
    const [result] = classifyContainers(
      [container("paco-sbx-session_live")],
      sessions,
    );

    expect(result?.ownership).toBe("live");
    expect(result?.sessionId).toBe("live");
    expect(result?.sessionTitle).toBe("Live one");
  });

  test("a container whose session row is archived is archived, not orphaned", () => {
    const [result] = classifyContainers(
      [container("paco-sbx-session_old", { running: false, state: "exited" })],
      sessions,
    );

    expect(result?.ownership).toBe("archived");
    expect(result?.sessionId).toBe("old");
  });

  test("every container is classified, and none is invented", () => {
    const results = classifyContainers(
      [
        container("paco-sbx-session_live"),
        container("paco-sbx-session_old"),
        container("paco-sbx-session_gone"),
      ],
      sessions,
    );

    expect(results.map((r) => r.ownership)).toEqual([
      "live",
      "archived",
      "orphaned",
    ]);
  });

  test("no session rows at all means everything is an orphan", () => {
    const results = classifyContainers(
      [container("paco-sbx-session_live"), container("paco-sbx-session_old")],
      [],
    );

    expect(results.every((r) => r.ownership === "orphaned")).toBe(true);
  });

  test("a session with no container on the host contributes nothing", () => {
    expect(classifyContainers([], sessions)).toEqual([]);
  });
});

describe("classifyWorkspaces", () => {
  const sessions = [
    sessionResourceNames(sessionRow({ id: "live" })),
    sessionResourceNames(sessionRow({ id: "old", status: "archived" })),
  ];

  test("a directory with no session row is orphaned", () => {
    const [result] = classifyWorkspaces([workspace("session_gone")], sessions);

    expect(result?.ownership).toBe("orphaned");
  });

  test("an archived session's directory is archived, never orphaned", () => {
    const [result] = classifyWorkspaces([workspace("session_old")], sessions);

    expect(result?.ownership).toBe("archived");
    expect(result?.sessionId).toBe("old");
  });

  test("a directory matching a legacy persisted name is not an orphan", () => {
    const legacy = [
      sessionResourceNames(
        sessionRow({
          id: "s1",
          sandboxState: { type: "docker", sandboxName: "legacy-name" },
        }),
      ),
    ];

    const [result] = classifyWorkspaces([workspace("legacy-name")], legacy);

    expect(result?.ownership).toBe("live");
    expect(result?.sessionId).toBe("s1");
  });

  test("carries the unsaved-work verdict onto the result", () => {
    const [clean] = classifyWorkspaces([workspace("session_gone")], sessions);
    const [dirty] = classifyWorkspaces(
      [
        workspace("session_other", {
          unsavedWork: cleanWork({ uncommittedFiles: 3 }),
        }),
      ],
      sessions,
    );

    expect(clean?.mayHoldUnsavedWork).toBe(false);
    expect(dirty?.mayHoldUnsavedWork).toBe(true);
  });
});

describe("mayHoldUnsavedWork", () => {
  test("a workspace that is committed and pushed holds nothing unique", () => {
    expect(mayHoldUnsavedWork(workspace("a"))).toBe(false);
  });

  test("uncommitted files count", () => {
    expect(
      mayHoldUnsavedWork(
        workspace("a", { unsavedWork: cleanWork({ uncommittedFiles: 1 }) }),
      ),
    ).toBe(true);
  });

  test("commits no remote has count", () => {
    expect(
      mayHoldUnsavedWork(
        workspace("a", {
          unsavedWork: cleanWork({ unpushedCommits: 4, hasRemote: false }),
        }),
      ),
    ).toBe(true);
  });

  test("a probe that could not run is treated as work, not as absence of work", () => {
    expect(mayHoldUnsavedWork(workspace("a", { unsavedWork: null }))).toBe(
      true,
    );
  });
});

describe("planReclaim", () => {
  const sessions = [
    sessionResourceNames(sessionRow({ id: "live" })),
    sessionResourceNames(sessionRow({ id: "old", status: "archived" })),
  ];

  test("never offers a running container that a live session owns", () => {
    const plan = planReclaim({
      containers: classifyContainers(
        [container("paco-sbx-session_live")],
        sessions,
      ),
      workspaces: [],
    });

    expect(plan.orphanedContainers).toEqual([]);
    expect(plan.stoppedContainers).toEqual([]);
  });

  test("offers an orphaned container even while it is running", () => {
    const plan = planReclaim({
      containers: classifyContainers(
        [container("paco-sbx-session_gone")],
        sessions,
      ),
      workspaces: [],
    });

    expect(plan.orphanedContainers.map((c) => c.name)).toEqual([
      "paco-sbx-session_gone",
    ]);
  });

  test("a stopped container of a live session is reclaimable, separately", () => {
    const plan = planReclaim({
      containers: classifyContainers(
        [
          container("paco-sbx-session_live", {
            running: false,
            state: "exited",
          }),
        ],
        sessions,
      ),
      workspaces: [],
    });

    expect(plan.orphanedContainers).toEqual([]);
    expect(plan.stoppedContainers.map((c) => c.name)).toEqual([
      "paco-sbx-session_live",
    ]);
  });

  test("the two container groups never overlap", () => {
    const plan = planReclaim({
      containers: classifyContainers(
        [
          container("paco-sbx-session_live", { running: false }),
          container("paco-sbx-session_old", { running: false }),
          container("paco-sbx-session_gone", { running: false }),
        ],
        sessions,
      ),
      workspaces: [],
    });

    const orphaned = new Set(plan.orphanedContainers.map((c) => c.name));
    expect(plan.stoppedContainers.some((c) => orphaned.has(c.name))).toBe(
      false,
    );
    expect(plan.orphanedContainers).toHaveLength(1);
    expect(plan.stoppedContainers).toHaveLength(2);
  });

  test("only orphaned directories are ever offered for removal", () => {
    const plan = planReclaim({
      containers: [],
      workspaces: classifyWorkspaces(
        [
          workspace("session_live"),
          workspace("session_old"),
          workspace("session_gone"),
        ],
        sessions,
      ),
    });

    expect(plan.orphanedWorkspaces.map((w) => w.name)).toEqual([
      "session_gone",
    ]);
  });

  test("an orphaned directory with unsaved work is still listed, so it can be seen", () => {
    const plan = planReclaim({
      containers: [],
      workspaces: classifyWorkspaces(
        [workspace("session_gone", { unsavedWork: null })],
        sessions,
      ),
    });

    expect(plan.orphanedWorkspaces).toHaveLength(1);
    expect(plan.orphanedWorkspaces[0]?.mayHoldUnsavedWork).toBe(true);
  });
});

describe("summarize", () => {
  test("adds up what is present and what the plan would free", () => {
    const sessions = [sessionResourceNames(sessionRow({ id: "live" }))];

    const containers = classifyContainers(
      [
        container("paco-sbx-session_live", { writableBytes: 100 }),
        container("paco-sbx-session_gone", {
          writableBytes: 200,
          running: false,
        }),
      ],
      sessions,
    );
    const workspaces = classifyWorkspaces(
      [
        workspace("session_live", { sizeBytes: 1000 }),
        workspace("session_gone", { sizeBytes: 3000 }),
      ],
      sessions,
    );
    const plan = planReclaim({ containers, workspaces });

    expect(summarize({ containers, workspaces, plan })).toEqual({
      workspaceCount: 2,
      workspaceBytes: 4000,
      containerCount: 2,
      runningContainerCount: 1,
      containerWritableBytes: 300,
      reclaimableBytes: 3200,
      orphanedWorkspaceCount: 1,
      orphanedWorkspaceBytes: 3000,
      orphanedContainerCount: 1,
      unmeasuredWorkspaceCount: 0,
    });
  });

  test("an empty host reports zeros rather than nothing", () => {
    const plan = planReclaim({ containers: [], workspaces: [] });

    expect(summarize({ containers: [], workspaces: [], plan })).toMatchObject({
      workspaceCount: 0,
      workspaceBytes: 0,
      containerCount: 0,
      reclaimableBytes: 0,
      unmeasuredWorkspaceCount: 0,
    });
  });

  // MINOR: a failed `du` folds into the byte totals as a placeholder 0,
  // which reads exactly like a genuinely empty directory unless something
  // downstream also surfaces how many measurements failed.
  test("an unmeasured workspace is counted, not silently folded into zero", () => {
    const sessions = [sessionResourceNames(sessionRow({ id: "live" }))];
    const workspaces = classifyWorkspaces(
      [
        workspace("session_live", { sizeBytes: 1000, measured: true }),
        workspace("session_unmeasured", { sizeBytes: 0, measured: false }),
      ],
      sessions,
    );
    const plan = planReclaim({ containers: [], workspaces });

    expect(summarize({ containers: [], workspaces, plan })).toMatchObject({
      workspaceCount: 2,
      workspaceBytes: 1000,
      unmeasuredWorkspaceCount: 1,
    });
  });
});
