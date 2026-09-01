import { beforeEach, describe, expect, mock, test } from "bun:test";
// Safe to import statically: this module is pure text classification and pulls
// in nothing server-side, which is the whole point of it having no
// "server-only" marker.
import {
  ARCHIVED,
  classifySetupFailure,
  DOCKER_NOT_RUNNING,
  GENERIC,
  setupFailureMessage,
  TIMED_OUT,
} from "@/lib/sandbox/setup-failure-copy";

mock.module("server-only", () => ({}));

/**
 * The intermittent "We couldn't set up a workspace" that a real operator hit.
 *
 * `getReadySessionSandbox` used to decide the whole story from one column:
 * `session.lifecycleError ?? "Workspace setup failed"`. That column is blanked
 * at the start of every provisioning run (`provisioning-kick.ts`), on purpose,
 * so a stale error from a previous attempt is never reported as if it described
 * the current one. The consequence was that a turn reading the session *while*
 * a run was in flight saw no cause at all, fell back to a string no matcher
 * matches, and classified as `unknown` — the generic sentence, for a session
 * that had not failed and might yet succeed.
 *
 * These tests drive the real step and assert on the words a user would read.
 */

type SandboxStateRecord = { type: "docker"; sandboxName: string } | null;

type TestSession = {
  id: string;
  status: "running" | "archived";
  title: string;
  branch: string | null;
  repoOwner: string | null;
  repoName: string | null;
  lifecycleState: string | null;
  lifecycleError: string | null;
  sandboxProvisioningRunId: string | null;
  sandboxState: SandboxStateRecord;
};

const ACTIVE_SANDBOX: SandboxStateRecord = {
  type: "docker",
  sandboxName: "session_s1",
};

const DOCKER_DOWN =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running? [paco:setup-reason=docker-not-running]";

let sessionRecord: TestSession | null = null;

type KickResult = {
  status: "started" | "existing" | "active" | "skipped";
  runId?: string;
  skipReason?: string;
};

type RunOutcome = { status: "provisioned" | "superseded" | "abandoned" };

/** Scripted, so each test states exactly how many round trips it expects. */
let kickScript: Array<() => KickResult> = [];
let waitScript: Array<() => RunOutcome> = [];

function patchSession(patch: Partial<TestSession>): void {
  if (sessionRecord) {
    sessionRecord = { ...sessionRecord, ...patch };
  }
}

const spies = {
  getSessionById: mock(() =>
    Promise.resolve(sessionRecord ? { ...sessionRecord } : null),
  ),
  kickSandboxProvisioningWorkflow: mock(() => {
    const next = kickScript.shift();
    if (!next) {
      throw new Error("kickSandboxProvisioningWorkflow called off-script");
    }
    return Promise.resolve(next());
  }),
  waitForSandboxProvisioningRun: mock((_runId: string) => {
    const next = waitScript.shift();
    if (!next) {
      throw new Error("waitForSandboxProvisioningRun called off-script");
    }
    return Promise.resolve(next());
  }),
  connectSandbox: mock(() =>
    Promise.resolve({ environmentDetails: "sandbox details" }),
  ),
  ensureChatWorktree: mock(() =>
    Promise.resolve({ path: "/workspace/chat", branch: "chat/c1" }),
  ),
  discoverSkills: mock(() => Promise.resolve([])),
  getSandboxSkillDirectories: mock(() => Promise.resolve([])),
  getCachedSkills: mock(() => Promise.resolve([])),
  setCachedSkills: mock(() => Promise.resolve()),
  buildChatEnvironmentDetails: mock(() => "environment"),
  hostWorkspaceFor: mock(() => "/workspace"),
};

// `lifecycle.ts` is in the graph for `readSandboxSetupOutlook`, and it pulls
// the rest of the sessions module in with it.
mock.module("@/lib/db/sessions", () => ({
  getSessionById: spies.getSessionById,
  getChatsBySessionId: mock(() => Promise.resolve([])),
  updateSession: mock(() => Promise.resolve(null)),
}));

mock.module("@/lib/sandbox/provisioning-kick", () => ({
  kickSandboxProvisioningWorkflow: spies.kickSandboxProvisioningWorkflow,
  waitForSandboxProvisioningRun: spies.waitForSandboxProvisioningRun,
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
  ensureChatWorktree: spies.ensureChatWorktree,
  discoverSkills: spies.discoverSkills,
}));

mock.module("@/lib/skills/directories", () => ({
  getSandboxSkillDirectories: spies.getSandboxSkillDirectories,
}));

mock.module("@/lib/skills-cache", () => ({
  getCachedSkills: spies.getCachedSkills,
  setCachedSkills: spies.setCachedSkills,
}));

mock.module("@/lib/agent/chat-environment", () => ({
  buildChatEnvironmentDetails: spies.buildChatEnvironmentDetails,
}));

mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: spies.hostWorkspaceFor,
}));

const { resolveChatSandboxRuntime } = await import("./chat-sandbox-runtime");

function resolveRuntime() {
  return resolveChatSandboxRuntime({
    sessionId: "s1",
    chatId: "c1",
  });
}

/** The words the user would actually have read, via the real classifier. */
async function copyForThrownSetupFailure(): Promise<string> {
  try {
    await resolveRuntime();
  } catch (error) {
    return setupFailureMessage(classifySetupFailure(error));
  }
  throw new Error("expected the runtime step to throw, but it resolved");
}

beforeEach(() => {
  sessionRecord = {
    id: "s1",
    status: "running",
    title: "Session",
    branch: "main",
    repoOwner: null,
    repoName: null,
    lifecycleState: "provisioning",
    lifecycleError: null,
    sandboxProvisioningRunId: null,
    sandboxState: null,
  };
  kickScript = [];
  waitScript = [];
  for (const spy of Object.values(spies)) {
    spy.mockClear();
  }
});

describe("a turn that arrives while provisioning is in flight", () => {
  test("does not report a setup failure, and follows the run that owns the session", async () => {
    // The window: another kick already owns provisioning for this session, so
    // this turn's kick attaches to nothing and gets no run to wait on. The
    // session row is mid-run — `lifecycleError` blanked, a run id claimed.
    patchSession({
      lifecycleState: "provisioning",
      lifecycleError: null,
      sandboxProvisioningRunId: "run-b",
    });

    kickScript = [
      () => ({ status: "skipped", skipReason: "superseded" }),
      () => ({ status: "existing", runId: "run-b" }),
    ];
    waitScript = [
      () => {
        patchSession({
          lifecycleState: "active",
          sandboxProvisioningRunId: null,
          sandboxState: ACTIVE_SANDBOX,
        });
        return { status: "provisioned" };
      },
    ];

    const runtime = await resolveRuntime();

    expect(runtime.sandboxState).toEqual(ACTIVE_SANDBOX);
    expect(spies.kickSandboxProvisioningWorkflow).toHaveBeenCalledTimes(2);
  });

  test("never reports the generic copy for a session that is still provisioning", async () => {
    // Nothing ever hands over: provisioning stays in flight for the whole of
    // this turn's patience. The honest answer is that we stopped waiting, not
    // that setup failed for an unknown reason.
    patchSession({
      lifecycleState: "provisioning",
      lifecycleError: null,
      sandboxProvisioningRunId: "run-b",
    });

    kickScript = Array.from({ length: 8 }, () => () => ({
      status: "skipped" as const,
      skipReason: "superseded",
    }));

    const copy = await copyForThrownSetupFailure();

    expect(copy).not.toBe(GENERIC);
    expect(copy).toBe(TIMED_OUT);
  });
});

describe("a provisioning run that was superseded", () => {
  test("is not reported as a setup failure", async () => {
    patchSession({
      lifecycleState: "provisioning",
      lifecycleError: null,
      sandboxProvisioningRunId: "run-a",
    });

    kickScript = [
      () => ({ status: "existing", runId: "run-a" }),
      () => ({ status: "existing", runId: "run-b" }),
    ];
    waitScript = [
      () => {
        // `runProvisioning` returned `{ skipped: true, reason: "run-replaced" }`:
        // run-b took the session over. Nothing failed.
        patchSession({ sandboxProvisioningRunId: "run-b" });
        return { status: "superseded" };
      },
      () => {
        patchSession({
          lifecycleState: "active",
          sandboxProvisioningRunId: null,
          sandboxState: ACTIVE_SANDBOX,
        });
        return { status: "provisioned" };
      },
    ];

    const runtime = await resolveRuntime();

    expect(runtime.sandboxState).toEqual(ACTIVE_SANDBOX);
  });
});

describe("a genuine failure", () => {
  test("still reaches the user as its own specific copy", async () => {
    patchSession({ sandboxProvisioningRunId: "run-a" });

    kickScript = [() => ({ status: "existing", runId: "run-a" })];
    waitScript = [
      () => {
        patchSession({
          lifecycleState: "failed",
          lifecycleError: DOCKER_DOWN,
          sandboxProvisioningRunId: null,
        });
        return { status: "provisioned" };
      },
    ];

    const copy = await copyForThrownSetupFailure();

    expect(copy).toBe(DOCKER_NOT_RUNNING);
    // A recorded failure must never be re-kicked into a fresh run: that would
    // hide the cause behind a second attempt.
    expect(spies.kickSandboxProvisioningWorkflow).toHaveBeenCalledTimes(1);
  });

  test("of an archived session says so, rather than the generic copy", async () => {
    kickScript = [
      () => {
        patchSession({ status: "archived" });
        return { status: "skipped", skipReason: "session-archived" };
      },
    ];

    const copy = await copyForThrownSetupFailure();

    expect(copy).toBe(ARCHIVED);
  });
});
