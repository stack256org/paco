import { describe, expect, test } from "bun:test";
import { classifyWorktreeRemoval } from "./chat-worktree-removal";

describe("classifyWorktreeRemoval", () => {
  test("a clean run removed it", () => {
    expect(classifyWorktreeRemoval({ success: true })).toEqual({
      kind: "removed",
    });
  });

  test.each([
    ["'/workspace/chats/abc' is not a working tree", "is not a working tree"],
    ["fatal: '/workspace/chats/abc' is not a valid path", "not a valid path"],
    ["fatal: cannot chdir: No such file or directory", "no such file"],
  ])("treats %p as already gone", (stderr) => {
    expect(classifyWorktreeRemoval({ stderr, success: false })).toEqual({
      kind: "already-absent",
    });
  });

  test("matches regardless of the case git used", () => {
    expect(
      classifyWorktreeRemoval({
        stderr: "FATAL: 'x' IS NOT A WORKING TREE",
        success: false,
      }),
    ).toEqual({ kind: "already-absent" });
  });

  test("a missing repository is a failure, not an absent worktree", () => {
    // It reads like the others but means the workspace is broken, and
    // succeeding here would delete the row and strand every worktree in it.
    expect(
      classifyWorktreeRemoval({
        stderr: "fatal: not a git repository",
        success: false,
      }),
    ).toEqual({ kind: "failed", reason: "fatal: not a git repository" });
  });

  test("a real failure is reported with git's own words", () => {
    expect(
      classifyWorktreeRemoval({
        stderr: "fatal: 'chats/abc' contains modified or untracked files",
        success: false,
      }),
    ).toEqual({
      kind: "failed",
      reason: "fatal: 'chats/abc' contains modified or untracked files",
    });
  });

  test("a silent failure still counts as a failure, never as absent", () => {
    const outcome = classifyWorktreeRemoval({ success: false });

    expect(outcome.kind).toBe("failed");
    // The point: an empty stderr must not be mistaken for "nothing to remove",
    // because that would delete the row and strand the directory.
    expect(outcome).toEqual({ kind: "failed", reason: "git did not say why." });
  });

  test("falls back to stdout when git wrote there instead", () => {
    expect(
      classifyWorktreeRemoval({
        stdout: "something went wrong",
        success: false,
      }),
    ).toEqual({ kind: "failed", reason: "something went wrong" });
  });
});
