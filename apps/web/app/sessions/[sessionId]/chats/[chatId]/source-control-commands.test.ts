import { describe, expect, test } from "bun:test";
import {
  MUTATION_TARGETS_STAGED,
  runCommit,
  runFileMutation,
} from "./source-control-commands";
import type {
  FileDiff,
  SourceControlApi,
  WorkingTreeStatus,
} from "./source-control-contract";

type Call = { method: string; args: unknown[] };

/**
 * A stand-in for the server that writes down what it was asked to do.
 *
 * The point of these tests is the wiring: that Stage calls `stageFiles` with
 * this chat and these paths and nothing else. A button wired to the
 * neighbouring action still looks right and still spins, so nothing about the
 * rendered panel would catch it.
 */
function recorder(overrides: Partial<SourceControlApi> = {}) {
  const calls: Call[] = [];
  const ok = async () => ({ success: true });
  const api: SourceControlApi = {
    commitStaged: async (...args) => {
      calls.push({ args, method: "commitStaged" });
      return { success: true, sha: "0123456789abcdef" };
    },
    discardFiles: async (...args) => {
      calls.push({ args, method: "discardFiles" });
      return await ok();
    },
    getFileDiff: async (...args) => {
      calls.push({ args, method: "getFileDiff" });
      return { binary: false, patch: "" } satisfies FileDiff;
    },
    getWorkingTreeStatus: async (...args) => {
      calls.push({ args, method: "getWorkingTreeStatus" });
      return {
        aheadOfBase: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      } satisfies WorkingTreeStatus;
    },
    stageFiles: async (...args) => {
      calls.push({ args, method: "stageFiles" });
      return await ok();
    },
    unstageFiles: async (...args) => {
      calls.push({ args, method: "unstageFiles" });
      return await ok();
    },
    ...overrides,
  };
  return { api, calls };
}

const PATHS = ["apps/web/app/page.tsx", "README.md"];

describe("runFileMutation", () => {
  test("Stage calls stageFiles with this chat and exactly these paths", async () => {
    const { api, calls } = recorder();

    const result = await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "stage",
      paths: PATHS,
    });

    expect(result.error).toBeNull();
    expect(calls).toEqual([{ args: ["chat-1", PATHS], method: "stageFiles" }]);
  });

  test("Unstage calls unstageFiles, not stageFiles", async () => {
    const { api, calls } = recorder();

    await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "unstage",
      paths: ["a.ts"],
    });

    expect(calls).toEqual([
      { args: ["chat-1", ["a.ts"]], method: "unstageFiles" },
    ]);
  });

  test("Discard calls discardFiles", async () => {
    const { api, calls } = recorder();

    await runFileMutation({
      api,
      chatId: "chat-9",
      kind: "discard",
      paths: ["scratch.txt"],
    });

    expect(calls).toEqual([
      { args: ["chat-9", ["scratch.txt"]], method: "discardFiles" },
    ]);
  });

  test("an empty selection asks the server nothing", async () => {
    const { api, calls } = recorder();

    const result = await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "stage",
      paths: [],
    });

    expect(calls).toEqual([]);
    expect(result.error).toBeNull();
  });

  test("passes the server's own refusal through, word for word", async () => {
    const { api } = recorder({
      stageFiles: async () => ({
        error: "That path is not inside this workspace.",
        success: false,
      }),
    });

    const result = await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "stage",
      paths: ["../etc/passwd"],
    });

    expect(result.error).toBe("That path is not inside this workspace.");
  });

  test("turns a thrown failure into a sentence rather than a crash", async () => {
    const { api } = recorder({
      discardFiles: async () => {
        throw new Error("The sandbox is not running.");
      },
    });

    const result = await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "discard",
      paths: ["a.ts"],
    });

    expect(result.error).toBe("The sandbox is not running.");
  });

  test("falls back to its own words when the failure has none", async () => {
    const { api } = recorder({
      unstageFiles: async () => ({ success: false }),
    });

    const result = await runFileMutation({
      api,
      chatId: "chat-1",
      kind: "unstage",
      paths: ["a.ts"],
    });

    expect(result.error).toBe("Could not unstage those files.");
  });

  test("knows which list each action's rows came from", () => {
    expect(MUTATION_TARGETS_STAGED.unstage).toBeTrue();
    expect(MUTATION_TARGETS_STAGED.stage).toBeFalse();
    expect(MUTATION_TARGETS_STAGED.discard).toBeFalse();
  });
});

describe("runCommit", () => {
  test("commits the trimmed message and hands back the sha", async () => {
    const { api, calls } = recorder();

    const result = await runCommit({
      api,
      chatId: "chat-1",
      message: "  tighten the parser  ",
    });

    expect(calls).toEqual([
      { args: ["chat-1", "tighten the parser"], method: "commitStaged" },
    ]);
    expect(result).toEqual({ error: null, sha: "0123456789abcdef" });
  });

  test("refuses a whitespace-only message without a round trip", async () => {
    const { api, calls } = recorder();

    const result = await runCommit({ api, chatId: "chat-1", message: "  \n " });

    expect(calls).toEqual([]);
    expect(result.error).toBe("Write a commit message before committing.");
  });

  test("reports the server's refusal when nothing is staged", async () => {
    const { api } = recorder({
      commitStaged: async () => ({
        error:
          "Nothing is staged. Stage the changes you want to include, then commit.",
        success: false,
      }),
    });

    const result = await runCommit({ api, chatId: "chat-1", message: "wip" });

    expect(result.sha).toBeNull();
    expect(result.error).toContain("Nothing is staged");
  });
});
