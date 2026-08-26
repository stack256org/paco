import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The contract, against a real repository.
 *
 * These functions exist to make git's own index the staging area, so a test
 * that asserted on the command strings would be testing the wrong thing: what
 * matters is that after `stageFiles` the operator's own `git status` says the
 * file is staged, and that after `commitStaged` the commit contains what they
 * chose and nothing else. Everything below the auth guard is therefore real
 * git in a temporary repository; only identity and the workspace lookup are
 * mocked.
 */

let repo = "";
let sessionUserId: string | null = "user-1";
let memberRole: string | null = "member";
let chatRow: { id: string; sessionId: string } | null = {
  id: "chat-1",
  sessionId: "session-1",
};

function sh(command: string, cwd: string): string {
  return execFileSync("bash", ["-c", command], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

const shellSandbox = {
  exec: async (command: string, cwd: string) => {
    try {
      return {
        success: true,
        exitCode: 0,
        stdout: sh(command, cwd),
        stderr: "",
        truncated: false,
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return {
        success: false,
        exitCode: 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        truncated: false,
      };
    }
  },
};

mock.module("server-only", () => ({}));

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: () =>
    Promise.resolve(sessionUserId ? { user: { id: sessionUserId } } : null),
}));

mock.module("@/lib/db/sessions", () => ({
  getChatById: () => Promise.resolve(chatRow),
  getSessionById: () =>
    Promise.resolve({
      id: "session-1",
      userId: "user-1",
      sandboxState: { type: "docker", sandboxName: "session_session-1" },
    }),
}));

mock.module("@/lib/org/membership", () => ({
  getMemberRole: () => Promise.resolve(memberRole),
}));

mock.module("@/lib/sandbox/utils", () => ({
  isSandboxActive: () => true,
}));

mock.module("@paco/sandbox", () => ({
  connectSandbox: () => Promise.resolve(shellSandbox),
}));

const resolveWorkCwd = mock(() => repo);
mock.module("@/lib/agent/workspace-paths", () => ({ resolveWorkCwd }));

const {
  commitStaged,
  discardFiles,
  getFileDiff,
  getWorkingTreeStatus,
  stageFiles,
  unstageFiles,
} = await import("./source-control-actions");

let root = "";

function write(relative: string, contents: string): void {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(repo, relative), "utf8");
}

beforeEach(() => {
  sessionUserId = "user-1";
  memberRole = "member";
  chatRow = { id: "chat-1", sessionId: "session-1" };
  resolveWorkCwd.mockClear();

  root = mkdtempSync(path.join(tmpdir(), "paco-sc-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  sh("git init -q -b main .", repo);
  write("keep.txt", "one\n");
  write("rename-me.txt", "content\n");
  write("doomed.txt", "delete me\n");
  write("logo.png", " binary ");
  sh("git add -A && git commit -qm base", repo);
  sh("git checkout -q -b chat/c1", repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── the guard ──────────────────────────────────────────────────────

describe("authorisation", () => {
  test("refuses a signed-out caller", async () => {
    sessionUserId = null;
    await expect(getWorkingTreeStatus("chat-1")).rejects.toThrow(/signed out/i);
    expect(await stageFiles("chat-1", ["keep.txt"])).toEqual({
      success: false,
      error: expect.stringMatching(/signed out/i),
    });
  });

  test("refuses a caller who does not own the session", async () => {
    sessionUserId = "someone-else";
    await expect(getWorkingTreeStatus("chat-1")).rejects.toThrow();
  });

  test("refuses a caller who is in no organisation", async () => {
    memberRole = null;
    await expect(getWorkingTreeStatus("chat-1")).rejects.toThrow();
  });

  test("refuses a chat that does not exist", async () => {
    chatRow = null;
    await expect(getWorkingTreeStatus("chat-1")).rejects.toThrow();
  });

  test("resolves the chat's worktree, never the session repository", async () => {
    // The session repository is a real repository on the default branch, so
    // asking it instead fails silently by reporting nothing.
    await getWorkingTreeStatus("chat-1");
    expect(resolveWorkCwd).toHaveBeenCalled();
    const call = resolveWorkCwd.mock.calls.at(-1) as unknown[];
    expect(call[1]).toBe("chat-1");
  });
});

// ── getWorkingTreeStatus ───────────────────────────────────────────

describe("getWorkingTreeStatus", () => {
  test("splits staged, unstaged and untracked", async () => {
    write("keep.txt", "staged change\n");
    sh("git add keep.txt", repo);
    write("doomed.txt", "unstaged change\n");
    write("brand-new.ts", "new\n");

    const status = await getWorkingTreeStatus("chat-1");

    expect(status.staged).toEqual([{ path: "keep.txt", status: "M" }]);
    expect(status.unstaged).toEqual([{ path: "doomed.txt", status: "M" }]);
    expect(status.untracked).toEqual([{ path: "brand-new.ts", status: "A" }]);
  });

  test("reports a file that is both staged and modified again, twice", async () => {
    // Staged content is a snapshot. When the agent rewrites a file the
    // operator already staged, there are two different diffs and only the
    // staged one gets committed — so the panel has to show both.
    write("keep.txt", "what I staged\n");
    sh("git add keep.txt", repo);
    write("keep.txt", "what the agent did afterwards\n");

    const status = await getWorkingTreeStatus("chat-1");

    expect(status.staged).toEqual([{ path: "keep.txt", status: "M" }]);
    expect(status.unstaged).toEqual([{ path: "keep.txt", status: "M" }]);
  });

  test("reports renames with the path they came from", async () => {
    sh("git mv rename-me.txt renamed.txt", repo);

    const status = await getWorkingTreeStatus("chat-1");

    expect(status.staged).toEqual([
      { path: "renamed.txt", status: "R", oldPath: "rename-me.txt" },
    ]);
  });

  test("reports deletions on the side they happened", async () => {
    fs.rmSync(path.join(repo, "doomed.txt"));

    const unstaged = (await getWorkingTreeStatus("chat-1")).unstaged;
    expect(unstaged).toEqual([{ path: "doomed.txt", status: "D" }]);

    sh("git add -A", repo);
    const staged = (await getWorkingTreeStatus("chat-1")).staged;
    expect(staged).toEqual([{ path: "doomed.txt", status: "D" }]);
  });

  test("survives paths with spaces and non-ASCII bytes", async () => {
    // Plain porcelain quotes these, and a caller that sliced three characters
    // off the front would hand git a path it cannot match.
    write("a folder/café notes.md", "hi\n");

    const status = await getWorkingTreeStatus("chat-1");
    expect(status.untracked).toEqual([
      { path: "a folder/café notes.md", status: "A" },
    ]);
  });

  test("counts the operator's own commits ahead of the base", async () => {
    expect((await getWorkingTreeStatus("chat-1")).aheadOfBase).toBe(0);

    write("keep.txt", "two\n");
    sh("git add -A && git commit -qm mine", repo);

    expect((await getWorkingTreeStatus("chat-1")).aheadOfBase).toBe(1);
  });
});

// ── staging ────────────────────────────────────────────────────────

describe("stageFiles / unstageFiles", () => {
  test("stages exactly what was asked for", async () => {
    write("keep.txt", "one edit\n");
    write("doomed.txt", "another edit\n");

    expect(await stageFiles("chat-1", ["keep.txt"])).toEqual({ success: true });

    expect(sh("git diff --cached --name-only", repo)).toBe("keep.txt\n");
  });

  test("stages a deletion, which plain `git add` would not", async () => {
    fs.rmSync(path.join(repo, "doomed.txt"));

    await stageFiles("chat-1", ["doomed.txt"]);

    expect(sh("git diff --cached --name-status -z", repo)).toBe(
      "D doomed.txt ",
    );
  });

  test("stages an untracked file", async () => {
    write("brand-new.ts", "new\n");

    await stageFiles("chat-1", ["brand-new.ts"]);

    expect(sh("git diff --cached --name-only", repo)).toBe("brand-new.ts\n");
  });

  test("stages from several turns at once, which is the point", async () => {
    // Several turns run without a commit; the operator picks files from two
    // of them and leaves the third turn's work alone.
    write("turn-one.ts", "1\n");
    write("turn-two.ts", "2\n");
    write("turn-three.ts", "3\n");

    await stageFiles("chat-1", ["turn-one.ts", "turn-three.ts"]);

    expect(sh("git diff --cached --name-only", repo)).toBe(
      "turn-one.ts\nturn-three.ts\n",
    );
    const status = await getWorkingTreeStatus("chat-1");
    expect(status.untracked).toEqual([{ path: "turn-two.ts", status: "A" }]);
  });

  test("unstages without touching the working tree", async () => {
    write("keep.txt", "edited\n");
    sh("git add keep.txt", repo);

    expect(await unstageFiles("chat-1", ["keep.txt"])).toEqual({
      success: true,
    });

    expect(sh("git diff --cached --name-only", repo)).toBe("");
    expect(read("keep.txt")).toBe("edited\n");
  });

  test("unstages both halves of a rename", async () => {
    // One row in the panel, two index entries. Unstaging by the new name
    // alone leaves the deletion staged and the rename half-undone.
    sh("git mv rename-me.txt renamed.txt", repo);

    await unstageFiles("chat-1", ["renamed.txt"]);

    expect(sh("git diff --cached --name-only", repo)).toBe("");
  });

  test("refuses a path that reaches outside the worktree", async () => {
    const result = await stageFiles("chat-1", ["../../etc/passwd"]);
    expect(result.success).toBe(false);
  });

  test("refuses a path inside .git", async () => {
    const result = await stageFiles("chat-1", [".git/config"]);
    expect(result.success).toBe(false);
  });
});

// ── discard ────────────────────────────────────────────────────────

describe("discardFiles", () => {
  test("throws away an unstaged edit", async () => {
    write("keep.txt", "unwanted\n");

    expect(await discardFiles("chat-1", ["keep.txt"])).toEqual({
      success: true,
    });

    expect(read("keep.txt")).toBe("one\n");
  });

  test("deletes an untracked file, the only thing discarding one can mean", async () => {
    write("brand-new.ts", "new\n");

    await discardFiles("chat-1", ["brand-new.ts"]);

    expect(fs.existsSync(path.join(repo, "brand-new.ts"))).toBe(false);
  });

  test("never destroys staged work", async () => {
    // Restores from the index, not from HEAD. Discarding the further edit
    // leaves the operator's deliberate selection exactly where it was.
    write("keep.txt", "what I staged\n");
    sh("git add keep.txt", repo);
    write("keep.txt", "what came afterwards\n");

    await discardFiles("chat-1", ["keep.txt"]);

    expect(read("keep.txt")).toBe("what I staged\n");
    expect(sh("git diff --cached --name-only", repo)).toBe("keep.txt\n");
  });
});

// ── commit ─────────────────────────────────────────────────────────

describe("commitStaged", () => {
  test("commits what is staged and nothing else", async () => {
    write("keep.txt", "chosen\n");
    write("doomed.txt", "not chosen\n");
    sh("git add keep.txt", repo);

    const result = await commitStaged("chat-1", "Only the part I picked");

    expect(result.success).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh("git show --name-only --format=%s HEAD", repo)).toBe(
      "Only the part I picked\n\nkeep.txt\n",
    );
    // The unstaged edit is still sitting there, uncommitted.
    expect(sh("git status --porcelain", repo)).toBe(" M doomed.txt\n");
  });

  test("refuses an empty message", async () => {
    write("keep.txt", "chosen\n");
    sh("git add keep.txt", repo);

    const result = await commitStaged("chat-1", "");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/commit message/i);
    expect(sh("git log --format=%s -1", repo).trim()).toBe("base");
  });

  test("refuses a message that is only whitespace", async () => {
    write("keep.txt", "chosen\n");
    sh("git add keep.txt", repo);

    const result = await commitStaged("chat-1", "   \n \t ");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/commit message/i);
  });

  test("refuses when nothing is staged", async () => {
    write("keep.txt", "edited but not staged\n");

    const result = await commitStaged("chat-1", "A perfectly good message");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nothing is staged/i);
    expect(sh("git log --format=%s -1", repo).trim()).toBe("base");
  });

  test("does not let a message run a command", async () => {
    write("keep.txt", "chosen\n");
    sh("git add keep.txt", repo);

    await commitStaged("chat-1", "fix: use `touch pwned` here");

    expect(sh("git log --format=%s -1", repo).trim()).toBe(
      "fix: use `touch pwned` here",
    );
    expect(fs.existsSync(path.join(repo, "pwned"))).toBe(false);
  });
});

// ── diffs ──────────────────────────────────────────────────────────

describe("getFileDiff", () => {
  test("returns a full unified patch, headers included", async () => {
    write("keep.txt", "two\n");

    const diff = await getFileDiff("chat-1", "keep.txt", { staged: false });

    expect(diff.binary).toBe(false);
    expect(diff.patch).toContain("diff --git a/keep.txt b/keep.txt");
    expect(diff.patch).toContain("--- a/keep.txt");
    expect(diff.patch).toContain("+++ b/keep.txt");
    expect(diff.patch).toContain("-one");
    expect(diff.patch).toContain("+two");
  });

  test("diffs the staged side separately from the unstaged one", async () => {
    write("keep.txt", "staged\n");
    sh("git add keep.txt", repo);
    write("keep.txt", "and then this\n");

    const stagedDiff = await getFileDiff("chat-1", "keep.txt", {
      staged: true,
    });
    const unstagedDiff = await getFileDiff("chat-1", "keep.txt", {
      staged: false,
    });

    expect(stagedDiff.patch).toContain("+staged");
    expect(unstagedDiff.patch).toContain("-staged");
    expect(unstagedDiff.patch).toContain("+and then this");
  });

  test("shows an untracked file as an addition, not an error", async () => {
    write("brand-new.ts", "export const x = 1;\n");

    const diff = await getFileDiff("chat-1", "brand-new.ts", {
      staged: false,
    });

    expect(diff.binary).toBe(false);
    expect(diff.patch).toContain("diff --git a/brand-new.ts b/brand-new.ts");
    expect(diff.patch).toContain("--- /dev/null");
    expect(diff.patch).toContain("+export const x = 1;");
    // Never named after /dev/null: the renderer reads the file's identity off
    // the `diff --git` line.
    expect(diff.patch).not.toContain("a/dev/null");
  });

  test("emits rename headers and reports where the file came from", async () => {
    sh("git mv rename-me.txt renamed.txt", repo);

    const diff = await getFileDiff("chat-1", "renamed.txt", { staged: true });

    expect(diff.oldPath).toBe("rename-me.txt");
    expect(diff.patch).toContain("rename from rename-me.txt");
    expect(diff.patch).toContain("rename to renamed.txt");
  });

  test("shows a deletion", async () => {
    fs.rmSync(path.join(repo, "doomed.txt"));

    const diff = await getFileDiff("chat-1", "doomed.txt", { staged: false });

    expect(diff.patch).toContain("+++ /dev/null");
    expect(diff.patch).toContain("-delete me");
  });

  test("reports a binary file as binary, with no patch", async () => {
    fs.writeFileSync(
      path.join(repo, "logo.png"),
      Buffer.from([0, 1, 2, 3, 0, 255, 254]),
    );

    const diff = await getFileDiff("chat-1", "logo.png", { staged: false });

    expect(diff.binary).toBe(true);
    expect(diff.patch).toBe("");
  });

  test("reports an untracked binary file as binary", async () => {
    fs.writeFileSync(
      path.join(repo, "new.bin"),
      Buffer.from([0, 1, 2, 3, 0, 255, 254]),
    );

    const diff = await getFileDiff("chat-1", "new.bin", { staged: false });

    expect(diff.binary).toBe(true);
    expect(diff.patch).toBe("");
  });
});
