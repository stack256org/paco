import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadMemorySectionForTurn } from "./load-for-turn";
import { orgMemoryDir, projectMemoryDir, userMemoryDir } from "./paths";
import { writeMemory } from "./store";

const ORIGINAL_PACO_HOME = process.env.PACO_HOME;

let sessionRepoDir: string;
let dataDir: string;

beforeEach(async () => {
  sessionRepoDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "paco-memory-turn-repo-"),
  );
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-memory-turn-data-"));
  // `userMemoryDir`/`orgMemoryDir` resolve under `dataDir()`, which reads
  // `PACO_HOME` — pointing it at a throwaway directory keeps this test from
  // touching (or depending on) a real user's data dir.
  process.env.PACO_HOME = dataDir;
});

afterEach(async () => {
  process.env.PACO_HOME = ORIGINAL_PACO_HOME;
  await fs.rm(sessionRepoDir, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("loadMemorySectionForTurn", () => {
  test("returns undefined when no scope has anything", async () => {
    const section = await loadMemorySectionForTurn({
      sessionRepoDir,
      userId: "user-1",
      organizationId: "org-1",
      prompt: "How do I run the tests?",
    });

    expect(section).toBeUndefined();
  });

  test("renders matching entries from project, user, and org scope", async () => {
    await writeMemory(projectMemoryDir(sessionRepoDir), {
      title: "Uses pnpm for tests",
      body: "Run `bun test` for unit tests; `pnpm run ci` only at the end.",
      source: "distilled",
    });
    await writeMemory(userMemoryDir("user-1"), {
      title: "Prefers concise test output",
      body: "Wants `bun test` output without the verbose reporter.",
      source: "manual",
    });
    await writeMemory(orgMemoryDir("org-1"), {
      title: "Org test conventions",
      body: "Every PR runs `bun test` in CI before merge.",
      source: "promoted",
    });

    const section = await loadMemorySectionForTurn({
      sessionRepoDir,
      userId: "user-1",
      organizationId: "org-1",
      prompt: "How do I run the tests?",
    });

    expect(section).toBeDefined();
    expect(section).toContain("## Memory");
    expect(section).toContain("Uses pnpm for tests");
    expect(section).toContain("Prefers concise test output");
    expect(section).toContain("Org test conventions");
  });

  test("skips project scope entirely when no sessionRepoDir is given, but still loads user/org", async () => {
    // The repo directory can fail to resolve independently of user/org
    // scope — losing project memory for one turn shouldn't also lose the
    // user's and organisation's.
    await writeMemory(projectMemoryDir(sessionRepoDir), {
      title: "Uses pnpm for tests",
      body: "Run `bun test` for unit tests.",
      source: "distilled",
    });
    await writeMemory(userMemoryDir("user-1"), {
      title: "Prefers concise test output",
      body: "Wants `bun test` output without the verbose reporter.",
      source: "manual",
    });
    await writeMemory(orgMemoryDir("org-1"), {
      title: "Org test conventions",
      body: "Every PR runs `bun test` in CI before merge.",
      source: "promoted",
    });

    const section = await loadMemorySectionForTurn({
      userId: "user-1",
      organizationId: "org-1",
      prompt: "How do I run the tests?",
    });

    expect(section).toContain("Prefers concise test output");
    expect(section).toContain("Org test conventions");
    expect(section).not.toContain("Uses pnpm for tests");
  });

  test("skips org scope entirely when no organizationId is given", async () => {
    await writeMemory(orgMemoryDir("org-1"), {
      title: "Org test conventions",
      body: "Every PR runs `bun test` in CI before merge.",
      source: "promoted",
    });
    await writeMemory(projectMemoryDir(sessionRepoDir), {
      title: "Uses pnpm for tests",
      body: "Run `bun test` for unit tests.",
      source: "distilled",
    });

    const section = await loadMemorySectionForTurn({
      sessionRepoDir,
      userId: "user-1",
      prompt: "How do I run the tests?",
    });

    expect(section).toContain("Uses pnpm for tests");
    expect(section).not.toContain("Org test conventions");
  });

  test("never throws: an unexpected failure logs and resolves to undefined", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      // swallow
    });

    const storeModule = await import("./store");
    const listMemorySpy = spyOn(storeModule, "listMemory").mockImplementation(
      () => {
        throw new Error("boom");
      },
    );

    try {
      const section = await loadMemorySectionForTurn({
        sessionRepoDir,
        userId: "user-1",
        organizationId: "org-1",
        prompt: "How do I run the tests?",
      });

      expect(section).toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      listMemorySpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
