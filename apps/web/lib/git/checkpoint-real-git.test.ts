import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { createCheckpoint, restoreCheckpoint, snapshotTurn } =
  await import("./checkpoint");

/**
 * The snapshot claims are claims about git, so they are tested against git.
 *
 * Every other test in this directory drives a fake sandbox and asserts on the
 * *commands* the module runs, which proves it asks for the right things and
 * nothing about what git does with them. "The snapshot never shows up in the
 * Changes list / in a diff against base / in `git log` / in a push" cannot be
 * demonstrated that way: it is a statement about reachability and refspecs.
 *
 * So this drives a real repository — with a real bare remote to push to —
 * through a `Sandbox` shim that runs the module's commands in a shell, exactly
 * as the Docker sandbox does.
 */

let root: string;
let repo: string;
let remote: string;

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

/** A `Sandbox` that is just this machine's shell. */
const sandbox = {
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
} as never;

function write(relative: string, contents: string): void {
  const target = path.join(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function read(relative: string): string | null {
  try {
    return fs.readFileSync(path.join(repo, relative), "utf8");
  } catch {
    return null;
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "paco-snapshot-"));
  repo = path.join(root, "repo");
  remote = path.join(root, "remote.git");

  fs.mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh(`git init -q --bare -b main ${JSON.stringify(remote)}`, root);

  write("tracked.txt", "one\n");
  write("doomed.txt", "delete me\n");
  write(".gitignore", "ignored/\n");
  write("ignored/build.js", "generated\n");
  sh("git add -A && git commit -qm base", repo);
  sh(`git remote add origin ${JSON.stringify(remote)}`, repo);
  sh("git push -q origin main", repo);
  sh("git checkout -q -b chat/c1", repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a snapshot of a real repository", () => {
  test("is invisible to the branch, to a diff against base, and to a push", async () => {
    write("tracked.txt", "two\n");
    write("brand-new.txt", "created by the turn\n");

    const snapshot = await snapshotTurn(sandbox, repo, "c1", "turn-1");
    expect(snapshot?.dirty).toBe(true);
    const sha = snapshot?.sha ?? "";
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // 1. Not a branch.
    expect(sh("git for-each-ref --format='%(refname)' refs/heads", repo)).toBe(
      "refs/heads/chat/c1\nrefs/heads/main\n",
    );

    // 2. Not in this branch's history — `git log` walks HEAD, and the
    //    snapshot is a *child* of HEAD, not an ancestor.
    expect(sh("git log --format=%H", repo)).not.toContain(sha);
    // Reachable from no branch and no remote-tracking ref. (`--all` would
    // include refs/paco itself, which is exactly where the snapshot lives.)
    expect(
      sh("git rev-list --branches --remotes --format=%H", repo),
    ).not.toContain(sha);

    // 3. Not in a diff against the base branch. Both the two-dot and the
    //    three-dot form, because the Changes tab and a pull request do not
    //    use the same one.
    expect(sh("git diff main..HEAD --stat", repo).trim()).toBe("");
    expect(sh("git diff main...HEAD --stat", repo).trim()).toBe("");
    expect(sh("git rev-list --count main..HEAD", repo).trim()).toBe("0");

    // 4. Not in the Changes list. `git status` reports exactly the two files
    //    the turn touched, and nothing about a snapshot.
    expect(sh("git status --porcelain", repo)).toBe(
      " M tracked.txt\n?? brand-new.txt\n",
    );

    // 5. Not pushed. The default refspec is refs/heads/*, and the remote ends
    //    up with no refs/paco/* at all.
    sh("git push -q --set-upstream origin chat/c1", repo);
    const remoteRefs = sh("git ls-remote origin", repo);
    expect(remoteRefs).not.toContain("refs/paco");
    expect(remoteRefs).not.toContain(sha);
    expect(remoteRefs).toContain("refs/heads/chat/c1");

    // And it really is stored, under the ref the design says.
    expect(
      sh("git for-each-ref --format='%(refname)' refs/paco", repo),
    ).toContain("refs/paco/turns/c1/turn-1");
    expect(sh("git rev-parse refs/paco/turns/c1/turn-1", repo).trim()).toBe(
      sha,
    );
  });

  test("does not disturb the staging area it is taking a picture of", async () => {
    // The single worst outcome available: an operator stages three files out
    // of ten, a turn ends, and the snapshot resets what they chose.
    write("tracked.txt", "staged content\n");
    write("staged-new.txt", "staged and new\n");
    sh("git add tracked.txt staged-new.txt", repo);
    write("tracked.txt", "and then edited further\n");
    write("untouched.txt", "never staged\n");

    const before = sh("git status --porcelain", repo);
    const indexBefore = sh("git ls-files --stage", repo);

    await createCheckpoint(sandbox, repo, "c1");

    expect(sh("git status --porcelain", repo)).toBe(before);
    expect(sh("git ls-files --stage", repo)).toBe(indexBefore);
    // The working tree is untouched too.
    expect(read("tracked.txt")).toBe("and then edited further\n");
    expect(read("untouched.txt")).toBe("never staged\n");
  });

  test("leaves no scratch files behind in the git directory", async () => {
    write("tracked.txt", "two\n");

    await createCheckpoint(sandbox, repo, "c1");

    const leftovers = fs
      .readdirSync(path.join(repo, ".git"))
      .filter((entry) => entry.startsWith("paco-snapshot-"));
    expect(leftovers).toEqual([]);
  });
});

describe("undoing a turn", () => {
  test("restores files the turn created, deleted, and rewrote", async () => {
    // Pre-turn state: one tracked edit and one untracked file the operator
    // wrote themselves.
    write("tracked.txt", "operator's edit\n");
    write("operator-note.md", "mine, untracked\n");

    const checkpoint = await createCheckpoint(sandbox, repo, "c1");
    expect(checkpoint?.dirty).toBe(true);

    // The turn runs: rewrites a file, deletes another, creates a third, and
    // stamps over the operator's untracked note.
    write("tracked.txt", "the agent's version\n");
    write("operator-note.md", "the agent overwrote this\n");
    write("agent-created.ts", "export const x = 1;\n");
    fs.rmSync(path.join(repo, "doomed.txt"));

    expect(
      await restoreCheckpoint(sandbox, repo, checkpoint?.sha ?? ""),
    ).toEqual({ ok: true });

    expect(read("tracked.txt")).toBe("operator's edit\n");
    // The untracked file is the one an undo silently fails to restore if the
    // snapshot only captured tracked content.
    expect(read("operator-note.md")).toBe("mine, untracked\n");
    // A file the turn created is gone, not left behind looking half-reverted.
    expect(read("agent-created.ts")).toBeNull();
    // A file the turn deleted is back.
    expect(read("doomed.txt")).toBe("delete me\n");
  });

  test("puts the staging area back exactly as it was", async () => {
    write("tracked.txt", "chosen for the commit\n");
    sh("git add tracked.txt", repo);
    write("doomed.txt", "deliberately not staged\n");

    const statusBefore = sh("git status --porcelain", repo);
    const checkpoint = await createCheckpoint(sandbox, repo, "c1");

    // The turn stages something else and rewrites the staged file.
    write("doomed.txt", "the agent's idea\n");
    sh("git add -A", repo);
    write("agent-created.ts", "export const x = 1;\n");

    await restoreCheckpoint(sandbox, repo, checkpoint?.sha ?? "");

    expect(sh("git status --porcelain", repo)).toBe(statusBefore);
    expect(sh("git diff --cached --name-only", repo)).toBe("tracked.txt\n");
  });

  test("does not move the branch, so committed work survives an undo", async () => {
    // The reason committing is now an explicit act: what the operator has
    // committed is theirs, and undoing a turn must not touch it.
    write("tracked.txt", "operator's commit\n");
    sh("git add -A && git commit -qm 'my own commit'", repo);
    const head = sh("git rev-parse HEAD", repo).trim();

    write("tracked.txt", "uncommitted, pre-turn\n");
    const checkpoint = await createCheckpoint(sandbox, repo, "c1");

    write("tracked.txt", "the agent's version\n");
    await restoreCheckpoint(sandbox, repo, checkpoint?.sha ?? "");

    expect(sh("git rev-parse HEAD", repo).trim()).toBe(head);
    expect(sh("git log --format=%s -1", repo).trim()).toBe("my own commit");
    expect(read("tracked.txt")).toBe("uncommitted, pre-turn\n");
  });

  test("never deletes ignored files, which it also never captured", async () => {
    // `git clean -fd` without `-x`. Build output and dependencies are not in
    // the snapshot, so removing them would be a deletion nothing can undo.
    write("tracked.txt", "two\n");
    const checkpoint = await createCheckpoint(sandbox, repo, "c1");

    write("ignored/build.js", "rebuilt during the turn\n");
    await restoreCheckpoint(sandbox, repo, checkpoint?.sha ?? "");

    expect(read("ignored/build.js")).toBe("rebuilt during the turn\n");
  });

  test("staging survives a turn that snapshots around it", async () => {
    // Turn 1 ends and is snapshotted; the operator stages one file; turn 2
    // ends and is snapshotted. What was staged is still staged.
    write("tracked.txt", "turn one's work\n");
    await snapshotTurn(sandbox, repo, "c1", "turn-1");

    sh("git add tracked.txt", repo);
    expect(sh("git diff --cached --name-only", repo)).toBe("tracked.txt\n");

    write("doomed.txt", "turn two's work\n");
    await snapshotTurn(sandbox, repo, "c1", "turn-2");

    expect(sh("git diff --cached --name-only", repo)).toBe("tracked.txt\n");
    expect(sh("git status --porcelain", repo)).toBe(
      " M doomed.txt\nM  tracked.txt\n",
    );
  });
});
