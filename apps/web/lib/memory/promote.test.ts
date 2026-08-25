import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// `promote.ts` pulls in `lib/db/tasks.ts` and `lib/org/membership.ts`, both
// of which import "server-only" — mocked away the same way
// `settings/agents/actions.test.ts` does it, so the real module bodies can
// still run under `bun test`.
mock.module("server-only", () => ({}));

let sessionUser: { id: string } | null = { id: "user-1" };
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: () =>
    Promise.resolve(
      sessionUser ? { user: sessionUser, created: 0 } : undefined,
    ),
}));

let organization: { id: string } | null = { id: "org-1" };
mock.module("@/lib/org/organization", () => ({
  getOrganization: () => Promise.resolve(organization),
}));

let memberRole: "owner" | "admin" | "member" | null = "member";
mock.module("@/lib/org/membership", () => ({
  getMemberRole: () => Promise.resolve(memberRole),
}));

/**
 * Only stands in for the "most recent session" lookup `promoteMemoryAction`
 * runs before filing a proposal task — the rest of `promote.ts`'s db use
 * goes through the mocked `@/lib/db/tasks` module below, not this fake.
 */
let recentSessionRows: Array<{ id: string }> = [{ id: "session-1" }];
mock.module("@/lib/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(recentSessionRows),
          }),
        }),
      }),
    }),
  },
}));

type CreateTaskCall = {
  organizationId: string;
  sessionId: string;
  title: string;
  goal: string;
  origin?: string;
  createdBy?: string | null;
};
const createTaskCalls: CreateTaskCall[] = [];
const transitionCalls: Array<{
  organizationId: string;
  taskId: string;
  to: string;
}> = [];
let createdTaskId = "task-1";

mock.module("@/lib/db/tasks", () => ({
  createTask: (input: CreateTaskCall) => {
    createTaskCalls.push(input);
    return Promise.resolve({ id: createdTaskId, status: "todo" });
  },
  transitionTaskStatus: (
    organizationId: string,
    taskId: string,
    to: string,
  ) => {
    transitionCalls.push({ organizationId, taskId, to });
    return Promise.resolve({ id: taskId, status: to });
  },
}));

const { promoteToOrgMemory, promoteMemoryAction } = await import("./promote");
const { orgMemoryDir } = await import("./paths");
const { listMemory } = await import("./store");

let dataDir: string;
let originalPacoHome: string | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-promote-test-"));
  originalPacoHome = process.env.PACO_HOME;
  process.env.PACO_HOME = dataDir;

  sessionUser = { id: "user-1" };
  organization = { id: "org-1" };
  memberRole = "member";
  recentSessionRows = [{ id: "session-1" }];
  createdTaskId = "task-1";
  createTaskCalls.length = 0;
  transitionCalls.length = 0;
});

afterEach(async () => {
  if (originalPacoHome === undefined) {
    delete process.env.PACO_HOME;
  } else {
    process.env.PACO_HOME = originalPacoHome;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("promoteToOrgMemory", () => {
  test("writes an entry tagged source 'promoted'", async () => {
    const { slug } = await promoteToOrgMemory({
      organizationId: "org-1",
      title: "Deploy convention",
      body: "Always deploy from main.",
      promotedBy: "user-1",
    });

    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe(slug);
    expect(entries[0]?.source).toBe("promoted");
    expect(entries[0]?.body).toBe("Always deploy from main.");
  });
});

describe("promoteMemoryAction", () => {
  test("an admin's proposal writes org memory directly, no task filed", async () => {
    memberRole = "admin";

    const result = await promoteMemoryAction({
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    expect(result).toEqual({
      ok: true,
      promoted: true,
      slug: "deploy-convention",
    });
    expect(createTaskCalls).toHaveLength(0);
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(1);
  });

  test("an owner's proposal also writes directly", async () => {
    memberRole = "owner";

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result).toEqual({ ok: true, promoted: true, slug: "t" });
  });

  test("a non-admin member's proposal files a blocked task instead of writing", async () => {
    memberRole = "member";

    const result = await promoteMemoryAction({
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    expect(result).toEqual({ ok: true, promoted: false, taskId: "task-1" });

    expect(createTaskCalls).toEqual([
      {
        organizationId: "org-1",
        sessionId: "session-1",
        title: "Org memory proposal: Deploy convention",
        goal: "Always deploy from main.",
        origin: "user",
        createdBy: "user-1",
      },
    ]);
    // Reaches `blocked` by walking the two legal edges, not a direct write.
    expect(transitionCalls).toEqual([
      { organizationId: "org-1", taskId: "task-1", to: "running" },
      { organizationId: "org-1", taskId: "task-1", to: "blocked" },
    ]);

    // Nothing landed in org memory — a non-admin's call never writes.
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(0);
  });

  test("a caller who isn't an org member is rejected before any task or write", async () => {
    memberRole = null;

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(false);
    expect(createTaskCalls).toHaveLength(0);
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(0);
  });

  test("a signed-out caller is rejected", async () => {
    sessionUser = null;

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(false);
  });

  test("a non-admin member with no session at all cannot file a proposal", async () => {
    memberRole = "member";
    recentSessionRows = [];

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(false);
    expect(createTaskCalls).toHaveLength(0);
  });
});
