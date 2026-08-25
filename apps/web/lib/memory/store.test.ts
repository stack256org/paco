import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  deleteMemory,
  listMemory,
  type MemoryEntry,
  parseMemoryFile,
  renderMemoryFile,
  writeMemory,
} from "./store";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-memory-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("renderMemoryFile / parseMemoryFile round-trip", () => {
  test("parses exactly what was rendered", () => {
    const entry: Omit<MemoryEntry, "slug"> = {
      title: "Prefers dark mode",
      updatedAt: "2026-08-20T10:00:00.000Z",
      source: "distilled",
      body: "The user prefers dark mode in the editor.",
    };

    const rendered = renderMemoryFile(entry);
    const parsed = parseMemoryFile(rendered, "prefers-dark-mode");

    expect(parsed).toEqual({ slug: "prefers-dark-mode", ...entry });
  });

  test("round-trips a title containing a colon and quotes", () => {
    const entry: Omit<MemoryEntry, "slug"> = {
      title: 'Uses "pnpm": not npm',
      updatedAt: "2026-08-20T10:00:00.000Z",
      source: "manual",
      body: "Line one.\nLine two.\n",
    };

    const rendered = renderMemoryFile(entry);
    const parsed = parseMemoryFile(rendered, "uses-pnpm-not-npm");

    expect(parsed).toEqual({ slug: "uses-pnpm-not-npm", ...entry });
  });

  test("returns undefined for content with no frontmatter", () => {
    expect(
      parseMemoryFile("just a body, no frontmatter", "some-slug"),
    ).toBeUndefined();
  });

  test("returns undefined when a required field is missing", () => {
    const broken = ["---", 'title: "Missing source"', "---", "", "body"].join(
      "\n",
    );
    expect(parseMemoryFile(broken, "missing-source")).toBeUndefined();
  });

  test("returns undefined for an unrecognised source value", () => {
    const broken = [
      "---",
      'title: "Bad source"',
      'updatedAt: "2026-08-20T10:00:00.000Z"',
      "source: invented",
      "---",
      "",
      "body",
    ].join("\n");
    expect(parseMemoryFile(broken, "bad-source")).toBeUndefined();
  });

  test("parses a CRLF-encoded file identically to its LF twin", () => {
    const entry: Omit<MemoryEntry, "slug"> = {
      title: "Prefers dark mode",
      updatedAt: "2026-08-20T10:00:00.000Z",
      source: "distilled",
      body: "Line one.\nLine two.",
    };

    const lf = renderMemoryFile(entry);
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(parseMemoryFile(crlf, "prefers-dark-mode")).toEqual(
      parseMemoryFile(lf, "prefers-dark-mode"),
    );
    expect(parseMemoryFile(crlf, "prefers-dark-mode")).toEqual({
      slug: "prefers-dark-mode",
      ...entry,
    });
  });

  test("round-trips a body containing a literal '---' line", () => {
    const entry: Omit<MemoryEntry, "slug"> = {
      title: "Has a divider",
      updatedAt: "2026-08-20T10:00:00.000Z",
      source: "manual",
      body: "Before the divider.\n---\nAfter the divider.",
    };

    const rendered = renderMemoryFile(entry);
    const parsed = parseMemoryFile(rendered, "has-a-divider");

    expect(parsed).toEqual({ slug: "has-a-divider", ...entry });
  });

  test("round-trips a body containing '\\n---\\n\\n'", () => {
    const entry: Omit<MemoryEntry, "slug"> = {
      title: "Has a blank-padded divider",
      updatedAt: "2026-08-20T10:00:00.000Z",
      source: "manual",
      body: "Section one.\n---\n\nSection two.",
    };

    const rendered = renderMemoryFile(entry);
    const parsed = parseMemoryFile(rendered, "has-a-blank-padded-divider");

    expect(parsed).toEqual({ slug: "has-a-blank-padded-divider", ...entry });
  });
});

describe("listMemory", () => {
  test("returns an empty list when the directory does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    expect(await listMemory(missing)).toEqual([]);
  });

  test("lists entries written to the directory", async () => {
    await writeMemory(dir, {
      title: "First note",
      body: "First body",
      source: "manual",
    });
    await writeMemory(dir, {
      title: "Second note",
      body: "Second body",
      source: "distilled",
    });

    const entries = await listMemory(dir);
    const titles = entries.map((e) => e.title).sort();
    expect(titles).toEqual(["First note", "Second note"]);
  });

  test("skips unparseable files and logs, without throwing", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "broken.md"),
      "not a memory file",
      "utf8",
    );
    await writeMemory(dir, {
      title: "Good note",
      body: "Good body",
      source: "manual",
    });

    const originalConsoleError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const entries = await listMemory(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.title).toBe("Good note");
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("ignores non-markdown files in the directory", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "notes.txt"), "irrelevant", "utf8");
    await writeMemory(dir, {
      title: "Only note",
      body: "Body",
      source: "manual",
    });

    const entries = await listMemory(dir);
    expect(entries).toHaveLength(1);
  });

  // Running as root bypasses directory permission bits entirely, which would
  // make this test pass without exercising anything — skip in that case.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  test.skipIf(isRoot)(
    "returns [] and logs, without throwing, on a non-ENOENT readdir error",
    async () => {
      const locked = path.join(dir, "locked");
      await writeMemory(locked, {
        title: "Unreachable",
        body: "Body",
        source: "manual",
      });
      await fs.chmod(locked, 0o000);

      const originalConsoleError = console.error;
      const errors: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        errors.push(args);
      };
      try {
        const entries = await listMemory(locked);
        expect(entries).toEqual([]);
        expect(errors.length).toBeGreaterThan(0);
      } finally {
        console.error = originalConsoleError;
        await fs.chmod(locked, 0o755);
      }
    },
  );
});

describe("writeMemory", () => {
  test("creates the directory on first write", async () => {
    const nested = path.join(dir, "nested", "memory");
    const { slug } = await writeMemory(nested, {
      title: "Deep note",
      body: "Body",
      source: "manual",
    });
    expect(slug).toBe("deep-note");
    const content = await fs.readFile(
      path.join(nested, "deep-note.md"),
      "utf8",
    );
    expect(content).toContain("Deep note");
  });

  test("slugifies the title", async () => {
    const { slug } = await writeMemory(dir, {
      title: "Uses PNPM & Bun!",
      body: "Body",
      source: "manual",
    });
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  test("collapses newlines in the title instead of corrupting the frontmatter", async () => {
    const { slug } = await writeMemory(dir, {
      title: "Multi\nLine\r\nTitle",
      body: "Body",
      source: "manual",
    });

    const [entry] = await listMemory(dir);
    expect(entry?.title).toBe("Multi Line Title");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  test("an existing slug is updated, not duplicated", async () => {
    const first = await writeMemory(dir, {
      title: "Same title",
      body: "Original body",
      source: "manual",
    });
    const second = await writeMemory(dir, {
      title: "Same title",
      body: "Updated body",
      source: "distilled",
    });

    expect(second.slug).toBe(first.slug);

    const entries = await listMemory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe("Updated body");
    expect(entries[0]?.source).toBe("distilled");
  });

  test("bumps updatedAt on overwrite", async () => {
    await writeMemory(dir, {
      title: "Timestamped",
      body: "v1",
      source: "manual",
    });
    const [before] = await listMemory(dir);

    await new Promise((resolve) => setTimeout(resolve, 5));

    await writeMemory(dir, {
      title: "Timestamped",
      body: "v2",
      source: "manual",
    });
    const [after] = await listMemory(dir);

    expect(before?.updatedAt).not.toBe(after?.updatedAt);
  });
});

describe("deleteMemory", () => {
  test("deletes an existing entry and returns true", async () => {
    const { slug } = await writeMemory(dir, {
      title: "To delete",
      body: "Body",
      source: "manual",
    });

    expect(await deleteMemory(dir, slug)).toBe(true);
    expect(await listMemory(dir)).toEqual([]);
  });

  test("returns false for a slug that does not exist", async () => {
    await fs.mkdir(dir, { recursive: true });
    expect(await deleteMemory(dir, "no-such-slug")).toBe(false);
  });

  test("rejects a path-traversal slug without touching the filesystem", async () => {
    await fs.mkdir(dir, { recursive: true });
    const outside = path.join(dir, "..", "escaped.md");

    expect(await deleteMemory(dir, "../escaped")).toBe(false);
    expect(await deleteMemory(dir, "..%2Fescaped")).toBe(false);
    expect(await deleteMemory(dir, "UPPER")).toBe(false);
    expect(await deleteMemory(dir, "")).toBe(false);

    await expect(fs.access(outside)).rejects.toThrow();
  });
});
