import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// ── `@/lib/session/get-server-session` ────────────────────────────

let authUserId: string | undefined = "user-1";
const getServerSessionMock = mock(() =>
  Promise.resolve(authUserId ? { user: { id: authUserId } } : null),
);
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: getServerSessionMock,
}));

// ── `@/lib/db/sessions` ──────────────────────────────────────────

let sessionRow: { userId: string; sandboxState: unknown } | undefined = {
  userId: "user-1",
  sandboxState: { sandboxName: "s1" },
};
const getSessionByIdMock = mock(() => Promise.resolve(sessionRow));
mock.module("@/lib/db/sessions", () => ({
  getSessionById: getSessionByIdMock,
}));

// ── `@/lib/org/membership` + `@/lib/org/organization` ──────────────

let memberRole: "owner" | "admin" | "member" | null = "member";
const getMemberRoleMock = mock(() => Promise.resolve(memberRole));
mock.module("@/lib/org/membership", () => ({
  getMemberRole: getMemberRoleMock,
}));

let organizationRow: { id: string } | null = { id: "org-1" };
const getOrganizationMock = mock(() => Promise.resolve(organizationRow));
mock.module("@/lib/org/organization", () => ({
  getOrganization: getOrganizationMock,
}));

// ── `@/lib/admin/require-admin` ──────────────────────────────────

let adminFlag = false;
const isAdminMock = mock(() => Promise.resolve(adminFlag));
mock.module("@/lib/admin/require-admin", () => ({
  isAdmin: isAdminMock,
}));

// ── `@/lib/agent/workspace-paths` + `@paco/sandbox` ───────────────

mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: mock(() => "/workspace/root"),
}));
mock.module("@paco/sandbox", () => ({
  repoDir: mock((root: string) => `${root}/repo`),
}));

// ── `@/lib/evals/discovery` (real schema, mocked discovery) ────────

const realDiscovery = await import("@/lib/evals/discovery");
type DiscoveryResult = Awaited<
  ReturnType<typeof realDiscovery.discoverEvalScenarios>
>;
const discoverEvalScenariosMock = mock((): Promise<DiscoveryResult> =>
  Promise.resolve({ scenarios: [], errors: [] }),
);
mock.module("@/lib/evals/discovery", () => ({
  ...realDiscovery,
  discoverEvalScenarios: discoverEvalScenariosMock,
}));

// ── `@/lib/evals/runner` ─────────────────────────────────────────

type RunCall = {
  organizationId: string;
  sessionId: string;
  scenarioName: string;
};
let runCalls: RunCall[] = [];
const runEvalScenarioMock = mock(
  (params: {
    organizationId: string;
    sessionId: string;
    scenario: { name: string };
  }) => {
    runCalls.push({
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      scenarioName: params.scenario.name,
    });
    return Promise.resolve({
      id: `run-${runCalls.length}`,
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      scenarioName: params.scenario.name,
      status: "passed" as const,
      details: { assertions: [] },
      rosterSnapshot: {},
      startedAt: new Date("2026-08-25T00:00:00Z"),
      finishedAt: new Date("2026-08-25T00:01:00Z"),
    });
  },
);
mock.module("@/lib/evals/runner", () => ({
  runEvalScenario: runEvalScenarioMock,
}));

// ── `@/lib/db/eval-runs` ─────────────────────────────────────────

const historyRows = [
  {
    id: "run-old",
    organizationId: "org-1",
    sessionId: "session-1",
    scenarioName: "smoke",
    status: "passed" as const,
    details: { assertions: [] },
    rosterSnapshot: {},
    startedAt: new Date("2026-08-24T00:00:00Z"),
    finishedAt: new Date("2026-08-24T00:01:00Z"),
  },
];
const listEvalRunsMock = mock(() => Promise.resolve(historyRows));
mock.module("@/lib/db/eval-runs", () => ({
  listEvalRuns: listEvalRunsMock,
}));

const {
  listEvalHistoryAction,
  listEvalScenariosAction,
  runAllEvalScenariosAction,
  runEvalScenarioAction,
} = await import("./actions");

function makeScenario(name = "smoke") {
  return {
    name,
    prompt: "do the thing",
    assertions: [{ kind: "file-exists" as const, path: "a" }],
    maxTurns: 25,
  };
}

beforeEach(() => {
  authUserId = "user-1";
  sessionRow = { userId: "user-1", sandboxState: { sandboxName: "s1" } };
  memberRole = "member";
  adminFlag = false;
  organizationRow = { id: "org-1" };
  runCalls = [];

  getServerSessionMock.mockClear();
  getSessionByIdMock.mockClear();
  getMemberRoleMock.mockClear();
  isAdminMock.mockClear();
  getOrganizationMock.mockClear();
  discoverEvalScenariosMock.mockClear();
  runEvalScenarioMock.mockClear();
  listEvalRunsMock.mockClear();
});

describe("auth", () => {
  test("listEvalScenariosAction rejects a signed-out caller", async () => {
    authUserId = undefined;
    await expect(listEvalScenariosAction("session-1")).rejects.toThrow();
  });

  test("rejects a caller who does not own the session", async () => {
    sessionRow = { userId: "someone-else", sandboxState: null };
    await expect(listEvalScenariosAction("session-1")).rejects.toThrow();
  });

  test("rejects a caller with no session record at all", async () => {
    sessionRow = undefined;
    await expect(listEvalScenariosAction("session-1")).rejects.toThrow();
  });

  test("rejects a caller who is neither an organisation member nor an admin", async () => {
    memberRole = null;
    adminFlag = false;
    await expect(listEvalScenariosAction("session-1")).rejects.toThrow();
  });

  /*
   * Migration 0005 creates exactly this population: an account promoted by
   * `users.is_admin` with no `organizationMembers` row at all (only the
   * oldest such account becomes an org `owner`). Every other surface accepts
   * them through `isAdmin`'s OR; requiring a membership row here locked them
   * out of Evals alone.
   */
  test("accepts an admin who holds the flag but has no membership row", async () => {
    memberRole = null;
    adminFlag = true;

    const result = await listEvalScenariosAction("session-1");

    expect(result).toEqual({ scenarios: [], errors: [] });
  });

  test("a flag-only admin may also run a scenario and read history", async () => {
    memberRole = null;
    adminFlag = true;

    await expect(listEvalHistoryAction("session-1")).resolves.toEqual(
      historyRows,
    );
    const row = await runEvalScenarioAction("session-1", makeScenario());
    expect(row.status).toBe("passed");
  });

  test("still rejects a flag-only admin who does not own the session", async () => {
    // Admin does not mean "may run evals in someone else's session": the
    // ownership check above is a separate gate and stays.
    sessionRow = { userId: "someone-else", sandboxState: null };
    memberRole = null;
    adminFlag = true;

    await expect(listEvalScenariosAction("session-1")).rejects.toThrow();
  });

  test("runEvalScenarioAction re-checks auth independently", async () => {
    authUserId = undefined;
    await expect(
      runEvalScenarioAction("session-1", makeScenario()),
    ).rejects.toThrow();
    expect(runEvalScenarioMock).not.toHaveBeenCalled();
  });
});

describe("listEvalScenariosAction", () => {
  test("returns empty results when the session has no sandbox yet", async () => {
    sessionRow = { userId: "user-1", sandboxState: null };
    const result = await listEvalScenariosAction("session-1");
    expect(result).toEqual({ scenarios: [], errors: [] });
    expect(discoverEvalScenariosMock).not.toHaveBeenCalled();
  });

  test("discovers scenarios from the session repo dir when a sandbox exists", async () => {
    discoverEvalScenariosMock.mockImplementationOnce(() =>
      Promise.resolve({
        scenarios: [makeScenario()],
        errors: ["bad.json: oops"],
      }),
    );

    const result = await listEvalScenariosAction("session-1");

    expect(discoverEvalScenariosMock).toHaveBeenCalledWith(
      "/workspace/root/repo",
    );
    expect(result.scenarios).toHaveLength(1);
    expect(result.errors).toEqual(["bad.json: oops"]);
  });
});

describe("listEvalHistoryAction", () => {
  test("returns this session's history for the organisation", async () => {
    const result = await listEvalHistoryAction("session-1");
    expect(listEvalRunsMock).toHaveBeenCalledWith("org-1", "session-1");
    expect(result).toEqual(historyRows);
  });
});

describe("runEvalScenarioAction", () => {
  test("runs the scenario and returns the persisted row", async () => {
    const row = await runEvalScenarioAction("session-1", makeScenario("smoke"));

    expect(runCalls).toEqual([
      {
        organizationId: "org-1",
        sessionId: "session-1",
        scenarioName: "smoke",
      },
    ]);
    expect(row.status).toBe("passed");
    expect(row.scenarioName).toBe("smoke");
  });

  test("rejects a malformed scenario before it reaches the runner", async () => {
    await expect(
      runEvalScenarioAction("session-1", {
        name: "smoke",
        prompt: "do the thing",
        assertions: [],
        maxTurns: 25,
      }),
    ).rejects.toThrow();
    expect(runEvalScenarioMock).not.toHaveBeenCalled();
  });
});

describe("runAllEvalScenariosAction", () => {
  test("runs every scenario sequentially and returns each persisted row", async () => {
    const rows = await runAllEvalScenariosAction("session-1", [
      makeScenario("first"),
      makeScenario("second"),
    ]);

    expect(runCalls.map((call) => call.scenarioName)).toEqual([
      "first",
      "second",
    ]);
    expect(rows).toHaveLength(2);
  });
});
