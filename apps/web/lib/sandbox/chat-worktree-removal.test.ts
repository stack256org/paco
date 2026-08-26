import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// ── The workspace side, mocked: this module's job is the decision, not
//    Docker. ─────────────────────────────────────────────────────────

type ExecResult = { success: boolean; stdout?: string; stderr?: string };

let execResults: ExecResult[] = [];
const execCalls: string[] = [];
const connectSandboxMock = mock(() =>
  Promise.resolve({
    exec: (command: string) => {
      execCalls.push(command);
      return Promise.resolve(execResults.shift() ?? { success: true });
    },
  }),
);
mock.module("@paco/sandbox", () => ({
  connectSandbox: connectSandboxMock,
  chatDir: (root: string, chatId: string) => `${root}/chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

mock.module("@/lib/agent/workspace-paths", () => ({
  hostWorkspaceFor: () => "/workspaces/s1",
}));

mock.module("@/lib/sandbox/utils", () => ({
  canOperateOnSandbox: Boolean,
}));

const { classifyWorktreeRemoval, removeChatWorktree } =
  await import("./chat-worktree-removal");

beforeEach(() => {
  execResults = [];
  execCalls.length = 0;
  connectSandboxMock.mockClear();
});

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

describe("removeChatWorktree", () => {
  test("removes the chat's own worktree", async () => {
    const outcome = await removeChatWorktree(
      { type: "docker", sandboxName: "s1" },
      "chat-1",
    );

    expect(outcome).toEqual({ kind: "removed" });
    expect(execCalls[0]).toContain("worktree remove");
    expect(execCalls[0]).toContain("/workspaces/s1/chats/chat-1");
  });

  test("touches nothing when the workspace is not running", async () => {
    const outcome = await removeChatWorktree(null, "chat-1");

    expect(outcome).toEqual({ kind: "not-running" });
    expect(connectSandboxMock).not.toHaveBeenCalled();
    expect(execCalls).toHaveLength(0);
  });
});
