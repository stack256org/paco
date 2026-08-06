import { describe, expect, test } from "bun:test";
import {
  chatBranchName,
  chatDir,
  chatWorktreePath,
  repoDir,
} from "./layout.ts";
import {
  ensureChatWorktree,
  migrateLegacyWorkspace,
  removeChatWorktree,
  type WorktreeExec,
} from "./worktree.ts";

/** Stands in for a workspace root; only its shape matters here. */
const ROOT = "/ws";

type Reply = { success?: boolean; stdout?: string; stderr?: string };

/**
 * A stand-in for the sandbox that records commands and answers by pattern.
 *
 * Worktree handling is almost entirely a sequence of git invocations, so what
 * matters is which commands run, in which directory, and how the code reacts
 * to each result — none of which needs a container.
 */
function fakeSandbox(replies: Array<[RegExp, Reply]> = []) {
  const calls: Array<{ command: string; cwd: string }> = [];

  const sandbox: WorktreeExec = {
    exec(command, cwd) {
      calls.push({ command, cwd });
      const match = replies.find(([pattern]) => pattern.test(command));
      const reply = match?.[1] ?? {};
      return Promise.resolve({
        success: reply.success ?? true,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
      });
    },
  };

  return {
    sandbox,
    calls,
    ran: (p: RegExp) => calls.some((c) => p.test(c.command)),
  };
}

describe("layout", () => {
  test("derives the worktree path and branch from the chat id", () => {
    expect(chatWorktreePath("abc123")).toBe("chats/abc123");
    expect(chatDir(ROOT, "abc123")).toBe("/ws/chats/abc123");
    expect(repoDir(ROOT)).toBe("/ws/repo");
    expect(chatBranchName("abc123")).toBe("chat/abc123");
  });

  test("refuses a chat id that could escape the workspace", () => {
    // Ids are generated, so this should be unreachable — which is why it
    // throws instead of quietly sanitising.
    expect(() => chatWorktreePath("../../etc")).toThrow();
    expect(() => chatDir(ROOT, "a/b")).toThrow();
    expect(() => chatBranchName("x;rm -rf /")).toThrow();
  });
});

describe("ensureChatWorktree", () => {
  test("returns the existing worktree without touching it", async () => {
    const { sandbox, calls, ran } = fakeSandbox([
      [/is-inside-work-tree/, { success: true, stdout: "true\n" }],
    ]);

    const worktree = await ensureChatWorktree(sandbox, ROOT, "abc123");

    expect(worktree).toEqual({
      path: "/ws/chats/abc123",
      relativePath: "chats/abc123",
      branch: "chat/abc123",
    });
    // In-progress work must never be disturbed by a routine re-check.
    expect(ran(/worktree add/)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("creates the branch and worktree when the chat is new", async () => {
    const { sandbox, calls, ran } = fakeSandbox([
      [/is-inside-work-tree/, { success: false }],
      [/rev-parse --verify HEAD/, { success: true }],
      [/show-ref/, { success: false }],
    ]);

    await ensureChatWorktree(sandbox, ROOT, "abc123");

    expect(ran(/git worktree prune/)).toBe(true);
    const add = calls.find((c) => /worktree add/.test(c.command));
    expect(add?.command).toBe(
      'git worktree add -b "chat/abc123" "/ws/chats/abc123"',
    );
    expect(add?.cwd).toBe("/ws/repo");
  });

  test("checks out an existing branch rather than creating a second one", async () => {
    // A chat whose directory was pruned still has its commits on its branch.
    const { sandbox, calls } = fakeSandbox([
      [/is-inside-work-tree/, { success: false }],
      [/rev-parse --verify HEAD/, { success: true }],
      [/show-ref/, { success: true }],
    ]);

    await ensureChatWorktree(sandbox, ROOT, "abc123");

    const add = calls.find((c) => /worktree add/.test(c.command));
    expect(add?.command).toBe(
      'git worktree add "/ws/chats/abc123" "chat/abc123"',
    );
  });

  test("gives an empty repository a commit to branch from", async () => {
    // `git worktree add -b` has no ref to point the new branch at until the
    // repository has at least one commit.
    const { sandbox, ran } = fakeSandbox([
      [/is-inside-work-tree/, { success: false }],
      [/rev-parse --verify HEAD/, { success: false }],
      [/show-ref/, { success: false }],
    ]);

    await ensureChatWorktree(sandbox, ROOT, "abc123");

    expect(ran(/commit --allow-empty/)).toBe(true);
  });

  test("does not add a commit when the repository already has one", async () => {
    const { sandbox, ran } = fakeSandbox([
      [/is-inside-work-tree/, { success: false }],
      [/rev-parse --verify HEAD/, { success: true }],
      [/show-ref/, { success: false }],
    ]);

    await ensureChatWorktree(sandbox, ROOT, "abc123");

    expect(ran(/commit --allow-empty/)).toBe(false);
  });

  test("reports why a worktree could not be created", async () => {
    const { sandbox } = fakeSandbox([
      [/is-inside-work-tree/, { success: false }],
      [/rev-parse --verify HEAD/, { success: true }],
      [/show-ref/, { success: false }],
      [/worktree add/, { success: false, stderr: "fatal: already registered" }],
    ]);

    await expect(ensureChatWorktree(sandbox, ROOT, "abc123")).rejects.toThrow(
      /already registered/,
    );
  });
});

describe("removeChatWorktree", () => {
  test("removes the directory but keeps the branch", async () => {
    const { sandbox, ran } = fakeSandbox();

    await removeChatWorktree(sandbox, ROOT, "abc123");

    expect(ran(/worktree remove --force "\/ws\/chats\/abc123"/)).toBe(true);
    expect(ran(/worktree prune/)).toBe(true);
    // Deleting a chat frees disk; it must not discard commits.
    expect(ran(/branch -D/)).toBe(false);
  });
});

describe("migrateLegacyWorkspace", () => {
  test("moves a root-level repository into repo/", async () => {
    const { sandbox, calls } = fakeSandbox([
      [/echo legacy/, { stdout: "legacy\n" }],
    ]);

    expect(await migrateLegacyWorkspace(sandbox, ROOT)).toBe(true);

    const move = calls.find((c) => /find \./.test(c.command));
    // Dotfiles must move too — leaving `.git` behind would orphan the history.
    expect(move?.command).toContain("-maxdepth 1 -mindepth 1");
    expect(move?.command).toContain("! -name repo");
    expect(move?.command).toContain("! -name chats");
  });

  test("is a no-op on a workspace that already has repo/", async () => {
    const { sandbox, ran } = fakeSandbox([
      [/echo legacy/, { stdout: "current\n" }],
    ]);

    expect(await migrateLegacyWorkspace(sandbox, ROOT)).toBe(false);
    expect(ran(/mkdir -p repo/)).toBe(false);
  });

  test("surfaces a failed move instead of continuing", async () => {
    const { sandbox } = fakeSandbox([
      [/echo legacy/, { stdout: "legacy\n" }],
      [/find \./, { success: false, stderr: "mv: permission denied" }],
    ]);

    await expect(migrateLegacyWorkspace(sandbox, ROOT)).rejects.toThrow(
      /permission denied/,
    );
  });
});
