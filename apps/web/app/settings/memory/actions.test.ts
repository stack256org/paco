import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// `getOrganization` (via `lib/org/organization.ts`) imports "server-only" —
// mocked away the same way `settings/agents/actions.test.ts` does it.
mock.module("server-only", () => ({}));

mock.module("@/lib/db/users", () => ({
  getSoleUserId: () => Promise.resolve("user-a"),
}));

let organization: { id: string } = { id: "org-1" };
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

describe("listUserMemory", () => {
  test("lists this instance's user-scope entries", async () => {
    await writeMemory(userMemoryDir("user-a"), {
      title: "A's note",
      body: "a",
      source: "manual",
    });

    const entries = await listUserMemory();

    expect(entries.map((entry) => entry.title)).toEqual(["A's note"]);
  });
});

describe("editUserMemory: the manual-on-edit rule", () => {
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

  test("editing a slug that does not exist fails", async () => {
    const result = await editUserMemory("does-not-exist", "tampered");

    expect(result.success).toBe(false);
  });
});

describe("deleteUserMemory", () => {
  test("deletes the entry", async () => {
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

describe("org memory", () => {
  test("lists the organisation's shared memory", async () => {
    await writeMemory(orgMemoryDir("org-1"), {
      title: "Org convention",
      body: "Deploy from main.",
      source: "promoted",
    });

    const entries = await listOrgMemory();

    expect(entries.map((entry) => entry.title)).toEqual(["Org convention"]);
  });

  test("an edit sets source to 'manual'", async () => {
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

  test("deletes an org entry", async () => {
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

  test("editOrgMemory and deleteOrgMemory validate the same way", async () => {
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
});
