import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const {
  deleteInstanceMemory,
  editInstanceMemory,
  listInstanceMemory,
} = await import("./actions");
const { instanceMemoryDir } = await import("@/lib/memory/paths");
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
});

afterEach(async () => {
  if (originalPacoHome === undefined) {
    delete process.env.PACO_HOME;
  } else {
    process.env.PACO_HOME = originalPacoHome;
  }
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("listInstanceMemory", () => {
  test("lists this instance's memory entries", async () => {
    await writeMemory(instanceMemoryDir(), {
      title: "A note",
      body: "a",
      source: "manual",
    });

    const entries = await listInstanceMemory();

    expect(entries.map((entry) => entry.title)).toEqual(["A note"]);
  });
});

describe("editInstanceMemory: the manual-on-edit rule", () => {
  test("sets source to 'manual' and updates the body, keeping the title", async () => {
    const { slug } = await writeMemory(instanceMemoryDir(), {
      title: "Editor preference",
      body: "Prefers vim bindings.",
      source: "distilled",
    });

    const result = await editInstanceMemory(
      slug,
      "Prefers emacs bindings now.",
    );

    expect(result.success).toBe(true);
    const [entry] = await listMemory(instanceMemoryDir());
    expect(entry?.source).toBe("manual");
    expect(entry?.body).toBe("Prefers emacs bindings now.");
    expect(entry?.title).toBe("Editor preference");
  });

  test("editing a slug that does not exist fails", async () => {
    const result = await editInstanceMemory("does-not-exist", "tampered");

    expect(result.success).toBe(false);
  });
});

describe("deleteInstanceMemory", () => {
  test("deletes the entry", async () => {
    const { slug } = await writeMemory(instanceMemoryDir(), {
      title: "A note",
      body: "a",
      source: "manual",
    });

    const result = await deleteInstanceMemory(slug);

    expect(result.success).toBe(true);
    expect(await listMemory(instanceMemoryDir())).toHaveLength(0);
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
  test("editInstanceMemory rejects a body longer than the limit, and writes nothing", async () => {
    const { slug } = await writeMemory(instanceMemoryDir(), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editInstanceMemory(
      slug,
      "x".repeat(MEMORY_BODY_MAX_LENGTH + 1),
    );

    expect(result.success).toBe(false);
    const [entry] = await listMemory(instanceMemoryDir());
    expect(entry?.body).toBe("original");
  });

  test("editInstanceMemory rejects a blank body rather than silently emptying an entry", async () => {
    const { slug } = await writeMemory(instanceMemoryDir(), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editInstanceMemory(slug, "   \n\t  ");

    expect(result.success).toBe(false);
    const [entry] = await listMemory(instanceMemoryDir());
    expect(entry?.body).toBe("original");
  });

  test("editInstanceMemory keeps a body's own leading whitespace — validation must not rewrite markdown", async () => {
    const { slug } = await writeMemory(instanceMemoryDir(), {
      title: "Editor preference",
      body: "original",
      source: "manual",
    });

    const result = await editInstanceMemory(slug, "    indented code block\n");

    expect(result.success).toBe(true);
    const [entry] = await listMemory(instanceMemoryDir());
    expect(entry?.body).toBe("    indented code block\n");
  });

  test("editInstanceMemory rejects a slug that is not a slug, before any directory read", async () => {
    const result = await editInstanceMemory("../../../etc/passwd", "anything");

    expect(result.success).toBe(false);
  });

  test("deleteInstanceMemory rejects a malformed slug", async () => {
    const result = await deleteInstanceMemory("../escape");

    expect(result.success).toBe(false);
  });
});
