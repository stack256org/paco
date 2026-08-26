import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { createCheckpoint, restoreCheckpoint, snapshotTurn } =
  await import("./checkpoint");

type Reply = { success?: boolean; stdout?: string; stderr?: string };

/** A sandbox that answers the git commands this module runs, and records them. */
function fakeSandbox(replies: Record<string, Reply> = {}) {
  const ran: string[] = [];
  const sandbox = {
    exec: async (command: string) => {
      ran.push(command);
      const key = Object.keys(replies)
        .filter((k) => command.includes(k))
        // Longest match wins, so "git rev-parse HEAD" beats "git rev-parse".
        .sort((a, b) => b.length - a.length)[0];
      const reply = key ? replies[key] : undefined;
      return {
        success: reply?.success ?? true,
        stdout: reply?.stdout ?? "",
        stderr: reply?.stderr ?? "",
      };
    },
  } as never;
  return { ran, sandbox };
}

/**
 * A chat's working directory and the git dir that really backs it.
 *
 * They are not `<cwd>/.git`: a chat is a linked worktree, so `.git` there is a
 * file pointing at the main repository's `worktrees/<name>` directory.
 */
const WORKTREE_CWD = "/w/chats/chat1";
const REAL_GIT_DIR = "/w/repo/.git/worktrees/chat1";

function dirtyWorktreeReplies(): Record<string, Reply> {
  return {
    "git rev-parse HEAD": { stdout: "abc123" },
    "git rev-parse --absolute-git-dir": { stdout: REAL_GIT_DIR },
    "git status --porcelain": { stdout: " M src/app.ts" },
    "git write-tree": { stdout: "tree99" },
    "git commit-tree": { stdout: "chk777" },
  };
}

describe("createCheckpoint", () => {
  test("uses HEAD directly when the tree is clean", async () => {
    // A turn that only reads must not leave anything behind.
    const { sandbox, ran } = fakeSandbox({
      "git rev-parse HEAD": { stdout: "abc123" },
      "git status --porcelain": { stdout: "" },
    });

    expect(await createCheckpoint(sandbox, "/w", "chat1")).toEqual({
      sha: "abc123",
      dirty: false,
    });
    expect(ran.some((c) => c.includes("commit-tree"))).toBe(false);
    expect(ran.some((c) => c.includes("update-ref"))).toBe(false);
  });

  test("never stages into the repository's own index", async () => {
    // This is the whole point. Committing the working tree meant the
    // checkpoint before one turn absorbed the previous turn's work, so the
    // Changes tab went empty and the user's edits ended up in a commit Paco
    // wrote. Every staging command must target a scratch index instead.
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    const result = await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    expect(result).toEqual({ sha: "chk777", dirty: true });

    const staging = ran.filter((c) => c.includes("git add"));
    expect(staging.length).toBeGreaterThan(0);
    for (const command of staging) {
      expect(command).toContain("GIT_INDEX_FILE=");
    }
    // And nothing may move the branch.
    // `git commit-tree` writes an object; `git commit` moves the branch.
    expect(ran.some((c) => /git commit(?!-tree)/.test(c))).toBe(false);
    expect(ran.some((c) => c.includes("git reset"))).toBe(false);
    expect(ran.some((c) => c.includes("git checkout"))).toBe(false);
    expect(ran.some((c) => c.includes("git stash"))).toBe(false);
  });

  test("reads the real index by copying it, never in place", async () => {
    // `git write-tree` on a live index rewrites its cache-tree extension and
    // takes index.lock to do it — so reading the staging area in place could
    // collide with the operator staging a file at that moment.
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    const writeTrees = ran.filter((c) => c.includes("git write-tree"));
    expect(writeTrees.length).toBe(2);
    for (const command of writeTrees) {
      expect(command).toContain("GIT_INDEX_FILE=");
    }
    expect(
      ran.some(
        (c) => c.startsWith("cp -f") && c.includes(`${REAL_GIT_DIR}/index`),
      ),
    ).toBe(true);
  });

  test("captures untracked files, so an undo can put a new file back", async () => {
    // `git add -A` in the scratch index, not `git add -u`: a turn that creates
    // a file and an undo that cannot remove it is worse than no undo.
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    expect(ran.some((c) => c.includes("git add -A"))).toBe(true);
  });

  test("puts the scratch index in the real git dir, not <cwd>/.git", async () => {
    /*
     * A chat's cwd is a linked worktree, where `.git` is a *file*. Writing the
     * scratch index to `<cwd>/.git/…` failed with "Not a directory", so
     * `createCheckpoint` returned null on every dirty tree — which is every
     * turn after the first — and Revert had nothing to restore.
     */
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    const indexed = ran.filter((c) => c.includes("GIT_INDEX_FILE="));
    expect(indexed.length).toBeGreaterThan(0);
    for (const command of indexed) {
      expect(command).toContain(`${REAL_GIT_DIR}/paco-snapshot-`);
      expect(command).not.toContain(`${WORKTREE_CWD}/.git/`);
    }
    // The git dir has to be asked for, and asked for absolutely: git resolves
    // GIT_INDEX_FILE against the directory a command runs in, not against cwd,
    // so a relative `.git` from `git rev-parse --git-dir` would not do.
    expect(ran).toContain("git rev-parse --absolute-git-dir");
  });

  test("keeps the checkpoint reachable so it is not garbage collected", async () => {
    // More urgent than it used to be: while turns committed, a checkpoint's
    // tree was reachable from the branch anyway. Nothing commits now.
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    expect(
      ran.some(
        (c) =>
          c.includes("git update-ref") &&
          c.includes("refs/paco/turns/chat1/") &&
          c.includes("chk777"),
      ),
    ).toBe(true);
  });

  test("writes only outside refs/heads, so it is never a branch", async () => {
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await createCheckpoint(sandbox, WORKTREE_CWD, "chat1");

    for (const command of ran.filter((c) => c.includes("update-ref"))) {
      expect(command).not.toContain("refs/heads");
      expect(command).not.toContain("refs/remotes");
    }
  });

  test("returns null when the git dir cannot be resolved", async () => {
    // Better no checkpoint than a scratch index written somewhere arbitrary.
    const { sandbox } = fakeSandbox({
      ...dirtyWorktreeReplies(),
      "git rev-parse --absolute-git-dir": {
        success: false,
        stderr: "not a git repository",
      },
    });

    expect(await createCheckpoint(sandbox, WORKTREE_CWD, "chat1")).toBeNull();
  });

  test("returns null in a repository with no commits", async () => {
    const { sandbox } = fakeSandbox({
      "git rev-parse HEAD": { success: false, stderr: "unknown revision" },
    });

    expect(await createCheckpoint(sandbox, "/w", "chat1")).toBeNull();
  });
});

describe("snapshotTurn", () => {
  test("files the post-turn tree under the turn's own ref", async () => {
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    expect(
      await snapshotTurn(sandbox, WORKTREE_CWD, "chat1", "turn-42"),
    ).toEqual({ sha: "chk777", dirty: true });

    expect(
      ran.some(
        (c) =>
          c.includes("git update-ref") &&
          c.includes("refs/paco/turns/chat1/turn-42"),
      ),
    ).toBe(true);
  });

  test("leaves the branch and the index alone, exactly as a checkpoint does", async () => {
    const { sandbox, ran } = fakeSandbox(dirtyWorktreeReplies());

    await snapshotTurn(sandbox, WORKTREE_CWD, "chat1", "turn-42");

    expect(ran.some((c) => /git commit(?!-tree)/.test(c))).toBe(false);
    for (const command of ran.filter((c) => c.includes("git add"))) {
      expect(command).toContain("GIT_INDEX_FILE=");
    }
  });
});

describe("restoreCheckpoint", () => {
  test("restores the tree without moving the branch", async () => {
    // The checkpoint commit is a child of HEAD, so resetting onto it would
    // leave the branch pointing at a commit Paco invented. read-tree puts the
    // files and index back and leaves HEAD alone, so work that was uncommitted
    // before the turn is uncommitted again after the revert.
    const { sandbox, ran } = fakeSandbox();

    expect(await restoreCheckpoint(sandbox, "/w", "chk777")).toEqual({
      ok: true,
    });
    expect(ran).toContain("git read-tree -u --reset chk777");
    expect(ran.some((c) => c.includes("git reset --hard"))).toBe(false);
  });

  test("removes files the turn created", async () => {
    // They are untracked in the restored index, so read-tree leaves them and
    // the revert would look half-applied.
    const { sandbox, ran } = fakeSandbox();

    await restoreCheckpoint(sandbox, "/w", "chk777");

    expect(ran).toContain("git clean -fd");
    // Never `-x`: ignored files were never captured, so removing them would
    // delete build output and dependencies nothing can put back.
    expect(ran.some((c) => c.includes("git clean") && c.includes("x"))).toBe(
      false,
    );
  });

  test("puts the staging area back from the snapshot's second parent", async () => {
    const { sandbox, ran } = fakeSandbox({
      "git log -1 --format=%s": { stdout: "paco snapshot" },
      "^2^{tree}": { stdout: "idxtree1" },
    });

    await restoreCheckpoint(sandbox, "/w", "chk777");

    // Without `-u`: the working tree keeps what the reset restored, and only
    // which files were staged is put back.
    expect(ran).toContain("git read-tree idxtree1");
  });

  test("never reads ^2 off a commit Paco did not write", async () => {
    // A clean-tree checkpoint *is* the branch's HEAD, and HEAD can be an
    // ordinary merge commit — whose second parent is somebody's branch, not a
    // staging area. Reading it would silently stage the wrong tree.
    const { sandbox, ran } = fakeSandbox({
      "git log -1 --format=%s": { stdout: "Merge pull request #12" },
      "^2^{tree}": { stdout: "someones-branch-tree" },
    });

    await restoreCheckpoint(sandbox, "/w", "abc123");

    expect(ran.some((c) => c.includes("^2^{tree}"))).toBe(false);
    expect(ran.some((c) => c.includes("read-tree someones"))).toBe(false);
  });

  test("refuses when the checkpoint is not in this worktree", async () => {
    const { sandbox, ran } = fakeSandbox({
      "git cat-file -e": { success: false, stderr: "not found" },
    });

    const result = await restoreCheckpoint(sandbox, "/w", "chk777");

    expect(result.ok).toBe(false);
    expect(ran.some((c) => c.includes("read-tree"))).toBe(false);
  });

  test("reports a failed restore instead of claiming success", async () => {
    const { sandbox } = fakeSandbox({
      "git read-tree": { success: false, stderr: "index locked" },
    });

    expect(await restoreCheckpoint(sandbox, "/w", "chk777")).toEqual({
      ok: false,
      reason: "failed",
      message: "index locked",
    });
  });
});
