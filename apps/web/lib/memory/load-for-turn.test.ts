import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadMemorySectionForTurn } from "./load-for-turn";
import { instanceMemoryDir, projectMemoryDir } from "./paths";
import { writeMemory } from "./store";

const ORIGINAL_PACO_HOME = process.env.PACO_HOME;

let sessionRepoDir: string;
let dataDir: string;

beforeEach(async () => {
  sessionRepoDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "paco-memory-turn-repo-"),
  );
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "paco-memory-turn-data-"));
  // `instanceMemoryDir` resolves under `dataDir()`, which reads
  // `PACO_HOME` — pointing it at a throwaway directory keeps this test from
  // touching (or depending on) a real instance's data dir.
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
      prompt: "How do I run the tests?",
    });

    expect(section).toBeUndefined();
  });

  test("renders matching entries from project and instance scope", async () => {
    await writeMemory(projectMemoryDir(sessionRepoDir), {
      title: "Uses pnpm for tests",
      body: "Run `bun test` for unit tests; `pnpm run ci` only at the end.",
      source: "distilled",
    });
    await writeMemory(instanceMemoryDir(), {
      title: "Prefers concise test output",
      body: "Wants `bun test` output without the verbose reporter.",
      source: "manual",
    });

    const section = await loadMemorySectionForTurn({
      sessionRepoDir,
      prompt: "How do I run the tests?",
    });

    expect(section).toBeDefined();
    expect(section).toContain("## Memory");
    expect(section).toContain("Uses pnpm for tests");
    expect(section).toContain("Prefers concise test output");
  });

  test("skips project scope entirely when no sessionRepoDir is given, but still loads instance scope", async () => {
    // The repo directory can fail to resolve independently of instance
    // scope — losing project memory for one turn shouldn't also lose the
    // instance's.
    await writeMemory(projectMemoryDir(sessionRepoDir), {
      title: "Uses pnpm for tests",
      body: "Run `bun test` for unit tests.",
      source: "distilled",
    });
    await writeMemory(instanceMemoryDir(), {
      title: "Prefers concise test output",
      body: "Wants `bun test` output without the verbose reporter.",
      source: "manual",
    });

    const section = await loadMemorySectionForTurn({
      prompt: "How do I run the tests?",
    });

    expect(section).toContain("Prefers concise test output");
    expect(section).not.toContain("Uses pnpm for tests");
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
