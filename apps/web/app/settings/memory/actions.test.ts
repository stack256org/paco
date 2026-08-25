import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// `requireAdmin` (via `lib/admin/require-admin.ts`) and `getOrganization`
// (via `lib/org/organization.ts`) both import "server-only" — mocked away
// the same way `settings/agents/actions.test.ts` does it.
mock.module("server-only", () => ({}));

let currentUserId: string | null = "user-a";
mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: () =>
    Promise.resolve(
      currentUserId ? { user: { id: currentUserId }, created: 0 } : undefined,
    ),
}));

let adminOk = true;
mock.module("@/lib/admin/require-admin", () => ({
  requireAdmin: () => {
    if (!adminOk) {
      return Promise.reject(new Error("Not an administrator"));
    }
    return Promise.resolve("admin-1");
  },
  // `actions.ts` never calls `isAdmin` directly, but `mock.module` replaces
  // this specifier for the whole test run, not just this file —
  // `lib/memory/promote.test.ts` also mocks it (for its own `isAdmin`
  // check) with a factory that has no `requireAdmin`. Exporting both here
  // keeps whichever mock happens to load first from breaking the other
  // file's static import of the export it actually needs.
  isAdmin: () => Promise.resolve(adminOk),
}));

let organization: { id: string } | null = { id: "org-1" };
mock.module("@/lib/org/organization", () => ({
  getOrganization: () => Promise.resolve(organization),
}));

const {
  deleteOrgMemory,
  deleteUserMemory,
  editOrgMemory,
  editUserMemory,
  listOrgMemory,
  listUserMemory,
} = await import("./actions");
const { orgMemoryDir, userMemoryDir } = await import("@/lib/memory/paths");
const { listMemory, writeMemory } = await import("@/lib/memory/store");
const { MEMORY_BODY_MAX_LENGTH } = await import("./memory-schemas");

let dataDir: string;
let originalPacoHome: string | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "paco-memory-settings-test-"),
  );
  originalPacoHome = process.env.PACO_HOME;
  process.env.PACO_HOME = dataDir;

  currentUserId = "user-a";
  adminOk = true;
  organization = { id: "org-1" };
});

afterEach(async () => {
  if (originalPacoHome === undefined) {
    delete process.env.PACO_HOME;
  } else {
    process.env.PACO_HOME = originalPacoHome;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("listUserMemory: scope isolation", () => {
  test("lists only the caller's own entries, never another user's", async () => {
    await writeMemory(userMemoryDir("user-a"), {
      title: "A's note",
      body: "a",
      source: "manual",
    });
    await writeMemory(userMemoryDir("user-b"), {
      title: "B's note",
      body: "b",
      source: "manual",
    });

    currentUserId = "user-a";
    const entries = await listUserMemory();

    expect(entries.map((entry) => entry.title)).toEqual(["A's note"]);
  });

  test("throws for a signed-out caller rather than returning an empty list", async () => {
    currentUserId = null;

    await expect(listUserMemory()).rejects.toThrow();
  });
});

describe("editUserMemory: isolation and the manual-on-edit rule", () => {
  test("sets source to 'manual' and updates the body, keeping the title", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-a"), {
      title: "Editor preference",
      body: "Prefers vim bindings.",
      source: "distilled",
    });

    const result = await editUserMemory(slug, "Prefers emacs bindings now.");

    expect(result.success).toBe(true);
    const [entry] = await listMemory(userMemoryDir("user-a"));
    expect(entry?.source).toBe("manual");
    expect(entry?.body).toBe("Prefers emacs bindings now.");
    expect(entry?.title).toBe("Editor preference");
  });

  test("user A editing a slug that only exists for user B fails, and B's entry is untouched", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-b"), {
      title: "B's note",
      body: "original",
      source: "manual",
    });

    currentUserId = "user-a";
    const result = await editUserMemory(slug, "tampered");

    expect(result.success).toBe(false);
    const [entry] = await listMemory(userMemoryDir("user-b"));
    expect(entry?.body).toBe("original");
  });
});

describe("deleteUserMemory: scope isolation", () => {
  test("user A cannot delete user B's entry: the path always derives from the session", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-b"), {
      title: "B's note",
      body: "b",
      source: "manual",
    });

    currentUserId = "user-a";
    const result = await deleteUserMemory(slug);

    expect(result.success).toBe(false);
    const stillThere = await listMemory(userMemoryDir("user-b"));
    expect(stillThere).toHaveLength(1);
  });

  test("deletes the caller's own entry", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-a"), {
      title: "A's note",
      body: "a",
      source: "manual",
    });

    const result = await deleteUserMemory(slug);

    expect(result.success).toBe(true);
    expect(await listMemory(userMemoryDir("user-a"))).toHaveLength(0);
  });
});

describe("org memory: admin gate", () => {
  test("a non-admin is rejected, not handed a field error", async () => {
    adminOk = false;

    await expect(listOrgMemory()).rejects.toThrow();
    await expect(editOrgMemory("some-slug", "body")).rejects.toThrow();
    await expect(deleteOrgMemory("some-slug")).rejects.toThrow();
  });

  test("an admin can list the organisation's shared memory", async () => {
    await writeMemory(orgMemoryDir("org-1"), {
      title: "Org convention",
      body: "Deploy from main.",
      source: "promoted",
    });

    const entries = await listOrgMemory();

    expect(entries.map((entry) => entry.title)).toEqual(["Org convention"]);
  });

  test("an admin's edit sets source to 'manual'", async () => {
    const { slug } = await writeMemory(orgMemoryDir("org-1"), {
      title: "Org convention",
      body: "Deploy from main.",
      source: "promoted",
    });

    const result = await editOrgMemory(slug, "Deploy from release/*.");

    expect(result.success).toBe(true);
    const [entry] = await listMemory(orgMemoryDir("org-1"));
    expect(entry?.source).toBe("manual");
    expect(entry?.body).toBe("Deploy from release/*.");
  });

  test("an admin can delete an org entry", async () => {
    const { slug } = await writeMemory(orgMemoryDir("org-1"), {
      title: "Org convention",
      body: "Deploy from main.",
      source: "promoted",
    });

    const result = await deleteOrgMemory(slug);

    expect(result.success).toBe(true);
    expect(await listMemory(orgMemoryDir("org-1"))).toHaveLength(0);
  });
});

/**
 * Every other settings section validates its write inputs with a Zod schema
 * before touching storage; this one used to take raw strings with nothing
 * but an existence check. Memory bodies are injected verbatim into agent
 * turns (`lib/memory/load-for-turn.ts`), so an unbounded or blank body is
 * not a cosmetic problem — it is unvalidated content on a prompt path.
 */
describe("write-path input validation", () => {
  test("editUserMemory rejects a body longer than the limit, and writes nothing", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-a"), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editUserMemory(
      slug,
      "x".repeat(MEMORY_BODY_MAX_LENGTH + 1),
    );

    expect(result.success).toBe(false);
    const [entry] = await listMemory(userMemoryDir("user-a"));
    expect(entry?.body).toBe("original");
  });

  test("editUserMemory rejects a blank body rather than silently emptying an entry", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-a"), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editUserMemory(slug, "   \n\t  ");

    expect(result.success).toBe(false);
    const [entry] = await listMemory(userMemoryDir("user-a"));
    expect(entry?.body).toBe("original");
  });

  test("editUserMemory keeps a body's own leading whitespace — validation must not rewrite markdown", async () => {
    const { slug } = await writeMemory(userMemoryDir("user-a"), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editUserMemory(slug, "    indented code block\n");

    expect(result.success).toBe(true);
    const [entry] = await listMemory(userMemoryDir("user-a"));
    expect(entry?.body).toBe("    indented code block\n");
  });

  test("editUserMemory rejects a slug that is not a slug, before any directory read", async () => {
    const result = await editUserMemory("../../../etc/passwd", "anything");

    expect(result.success).toBe(false);
  });

  test("deleteUserMemory rejects a malformed slug", async () => {
    const result = await deleteUserMemory("../escape");

    expect(result.success).toBe(false);
  });

  test("editOrgMemory and deleteOrgMemory validate the same way, after the admin gate", async () => {
    await expect(
      editOrgMemory("../../../etc/passwd", "anything"),
    ).resolves.toMatchObject({ success: false });
    await expect(deleteOrgMemory("../escape")).resolves.toMatchObject({
      success: false,
    });

    const { slug } = await writeMemory(orgMemoryDir("org-1"), {
      title: "Org convention",
      body: "Deploy from main.",
      source: "promoted",
    });
    const tooLong = await editOrgMemory(
      slug,
      "x".repeat(MEMORY_BODY_MAX_LENGTH + 1),
    );
    expect(tooLong.success).toBe(false);
    const [entry] = await listMemory(orgMemoryDir("org-1"));
    expect(entry?.body).toBe("Deploy from main.");
  });

  test("the admin gate still runs before validation: a non-admin gets rejected, not a field error", async () => {
    adminOk = false;

    await expect(editOrgMemory("../nope", "body")).rejects.toThrow();
    await expect(deleteOrgMemory("../nope")).rejects.toThrow();
  });
});
