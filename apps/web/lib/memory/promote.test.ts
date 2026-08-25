import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// `promote.ts` pulls in `lib/db/tasks.ts`, `lib/admin/require-admin.ts`, and
// `lib/org/membership.ts`, all of which import "server-only" — mocked away
// the same way `settings/agents/actions.test.ts` does it, so the real
// module bodies can still run under `bun test`.
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

/**
 * `isAdmin` is the OR of the `users.is_admin` flag and the org
 * `admin`/`owner` role (see `lib/admin/require-admin.ts`) — mocked directly
 * here rather than composed from a role, so a test can exercise the
 * "flagged admin with no org role at all" case the real composition allows.
 */
let isAdminFlag = false;
mock.module("@/lib/admin/require-admin", () => ({
  isAdmin: () => Promise.resolve(isAdminFlag),
  // `promote.ts` never calls `requireAdmin` directly, but `mock.module`
  // replaces this specifier for the whole test run, not just this file —
  // `settings/memory/actions.test.ts` also mocks it (for its own
  // `requireAdmin` gate) with a factory that has no `isAdmin`. Exporting
  // both here keeps whichever mock happens to load first from breaking the
  // other file's static import of the export it actually needs.
  requireAdmin: () =>
    isAdminFlag
      ? Promise.resolve("user-1")
      : Promise.reject(new Error("Not an administrator")),
}));

let memberRole: "owner" | "admin" | "member" | null = "member";
mock.module("@/lib/org/membership", () => ({
  getMemberRole: () => Promise.resolve(memberRole),
}));

/**
 * `@/lib/db/tasks` (the *real* module, used by `apps/web/lib/db/tasks.test.ts`
 * too) is deliberately NOT mocked here — mocking a module another test file
 * exercises for real would leak, since `mock.module` replaces a module for
 * the whole process, not just this file (bitten by exactly this once: see
 * git history around this comment). Instead only the lower-level dependency
 * both `promote.ts` and the real `createTask` sit on — `@/lib/db/client` —
 * is faked, matching what every other test file in this codebase mocks.
 */
type InsertedTaskRow = { id: string } & Record<string, unknown>;
const insertedTasks: InsertedTaskRow[] = [];

mock.module("@/lib/db/client", () => ({
  db: {
    insert: (_table: unknown) => ({
      values: (value: InsertedTaskRow) => ({
        returning: () => {
          const row = { ...value };
          insertedTasks.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
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
  isAdminFlag = false;
  memberRole = "member";
  insertedTasks.length = 0;
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
  test("writes an entry tagged source 'promoted', with promotedBy set", async () => {
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
    expect(entries[0]?.promotedBy).toBe("user-1");
  });
});

describe("promoteMemoryAction", () => {
  test("an admin's proposal writes org memory directly, no task filed", async () => {
    isAdminFlag = true;
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
    expect(insertedTasks).toHaveLength(0);
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.promotedBy).toBe("user-1");
  });

  test("an owner's proposal also writes directly", async () => {
    isAdminFlag = true;
    memberRole = "owner";

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result).toEqual({ ok: true, promoted: true, slug: "t" });
  });

  test("an is_admin-flagged user with no org role at all still writes directly", async () => {
    isAdminFlag = true;
    memberRole = null;

    const result = await promoteMemoryAction({
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    expect(result).toEqual({
      ok: true,
      promoted: true,
      slug: "deploy-convention",
    });
    expect(insertedTasks).toHaveLength(0);
  });

  test("a non-admin member's proposal files a task already 'blocked', not written", async () => {
    isAdminFlag = false;
    memberRole = "member";

    const result = await promoteMemoryAction({
      title: "Deploy convention",
      body: "Always deploy from main.",
    });

    expect(result.ok).toBe(true);
    expect(insertedTasks).toHaveLength(1);
    const [task] = insertedTasks;
    expect(task).toMatchObject({
      organizationId: "org-1",
      sessionId: null,
      title: "Org memory proposal: Deploy convention",
      goal: "Always deploy from main.",
      origin: "user",
      createdBy: "user-1",
      status: "blocked",
    });
    if (result.ok && !result.promoted) {
      expect(result.taskId).toBe(task?.id);
    } else {
      throw new Error("expected a non-promoted, task-filed result");
    }

    // Nothing landed in org memory — a non-admin's call never writes.
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(0);
  });

  test("a caller who is neither an admin nor an org member is rejected before any task or write", async () => {
    isAdminFlag = false;
    memberRole = null;

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(false);
    expect(insertedTasks).toHaveLength(0);
    const entries = await listMemory(orgMemoryDir("org-1"));
    expect(entries).toHaveLength(0);
  });

  test("a signed-out caller is rejected", async () => {
    sessionUser = null;

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(false);
  });

  test("a non-admin member with no sessions at all can still propose: the task is filed with no session", async () => {
    isAdminFlag = false;
    memberRole = "member";

    const result = await promoteMemoryAction({ title: "T", body: "B" });

    expect(result.ok).toBe(true);
    expect(insertedTasks).toHaveLength(1);
    expect(insertedTasks[0]).toMatchObject({ sessionId: null });
  });
});
