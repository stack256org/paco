import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The Changes tab's data, against real repositories.
 *
 * The customer report this guards: a session used as a workspace, several
 * projects cloned into it, and the Changes tab showing only the parent
 * repository's edits. Everything below the database is real git in a
 * temporary directory tree; only the cache write is mocked out.
 */

mock.module("server-only", () => ({}));

const updateSession = mock(() => Promise.resolve());
mock.module("@/lib/db/sessions", () => ({ updateSession }));

const { computeAndCacheDiff } = await import("./compute-diff");

let worktree = "";

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

const sandbox = {
  workingDirectory: "",
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
  readFile: (filePath: string, _encoding: "utf-8") =>
    Promise.resolve(fs.readFileSync(filePath, "utf8")),
  // The module only touches the three members above.
} as never;

function write(relative: string, contents: string): void {
  const target = path.join(worktree, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function initNested(relative: string): void {
  const dir = path.join(worktree, relative);
  fs.mkdirSync(dir, { recursive: true });
  sh("git init -q -b main .", dir);
  fs.writeFileSync(path.join(dir, "committed.txt"), "committed\n");
  sh("git add -A && git commit -qm base", dir);
}

let root = "";

beforeEach(() => {
  updateSession.mockClear();
  root = mkdtempSync(path.join(tmpdir(), "paco-diff-"));
  worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree);
  sh("git init -q -b main .", worktree);
  write("base.txt", "base\n");
  sh("git add -A && git commit -qm base", worktree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function compute() {
  return computeAndCacheDiff({
    sandbox,
    sessionId: "session-1",
    cwd: worktree,
  });
}

describe("single-repository workspaces (unchanged behaviour)", () => {
  test("reports tracked edits and untracked files", async () => {
    write("base.txt", "edited\n");
    write("brand-new.ts", "export {};\n");

    const diff = await compute();

    expect(diff.files.map((f) => f.path).sort()).toEqual([
      "base.txt",
      "brand-new.ts",
    ]);
    expect(diff.baseRef).toBe("HEAD");
    expect(updateSession).toHaveBeenCalled();
  });

  test("a repository with no commits lists untracked files", async () => {
    const bare = path.join(root, "unborn");
    fs.mkdirSync(bare);
    sh("git init -q -b main .", bare);
    fs.writeFileSync(path.join(bare, "first.ts"), "x\n");

    const diff = await computeAndCacheDiff({
      sandbox,
      sessionId: "session-1",
      cwd: bare,
    });

    expect(diff.files.map((f) => f.path)).toEqual(["first.ts"]);
    expect(diff.baseRef).toBe("(no commits)");
  });
});

describe("multi-repository workspaces", () => {
  test("the customer's bug: nested repositories' changes appear, prefixed", async () => {
    initNested("api");
    initNested("projects/web");
    write("api/committed.txt", "api edit\n");
    write("projects/web/new-page.tsx", "page\n");
    write("base.txt", "parent edit\n");

    const diff = await compute();
    const paths = diff.files.map((f) => f.path).sort();

    expect(paths).toEqual([
      "api/committed.txt",
      "base.txt",
      "projects/web/new-page.tsx",
    ]);

    const apiFile = diff.files.find((f) => f.path === "api/committed.txt");
    expect(apiFile?.status).toBe("modified");
    expect(apiFile?.diff).toContain(
      "diff --git a/api/committed.txt b/api/committed.txt",
    );
    expect(apiFile?.diff).toContain("+api edit");
  });

  test("the opaque nested-repo directory row never appears", async () => {
    initNested("api");

    const diff = await compute();

    expect(diff.files.map((f) => f.path)).not.toContain("api/");
    expect(diff.files.map((f) => f.path)).not.toContain("api");
    // A clean nested repository contributes nothing at all.
    expect(diff.files).toEqual([]);
    expect(diff.summary.totalFiles).toBe(0);
  });

  test("a gitlink recorded in the parent is dropped in favour of real changes", async () => {
    initNested("api");
    sh(
      "git -c advice.addEmbeddedRepo=false add api && git commit -qm gitlink",
      worktree,
    );
    write("api/committed.txt", "dirty\n");

    const diff = await compute();

    expect(diff.files.map((f) => f.path)).toContain("api/committed.txt");
    expect(diff.files.map((f) => f.path)).not.toContain("api");
  });

  test("a nested repository with no commits contributes its untracked files", async () => {
    const dir = path.join(worktree, "born");
    fs.mkdirSync(dir);
    sh("git init -q -b main .", dir);
    write("born/first.ts", "x\n");

    const diff = await compute();

    expect(diff.files.map((f) => f.path)).toEqual(["born/first.ts"]);
  });

  test("summary totals span every repository", async () => {
    initNested("api");
    write("api/committed.txt", "one\ntwo\n"); // committed\n -> 2 lines: +2 -1
    write("fresh.txt", "a\nb\nc\n"); // untracked in parent: +3

    const diff = await compute();

    expect(diff.summary.totalFiles).toBe(2);
    expect(diff.summary.totalAdditions).toBe(5);
    expect(diff.summary.totalDeletions).toBe(1);
  });

  test("a nested repository ahead of its own origin shows its branch work", async () => {
    // A clone with an origin: the common customer case, three projects
    // cloned into one workspace.
    const upstream = path.join(root, "upstream.git");
    fs.mkdirSync(upstream);
    sh("git init -q --bare -b main .", upstream);
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    sh("git init -q -b main .", seed);
    fs.writeFileSync(path.join(seed, "lib.ts"), "v1\n");
    sh(
      `git add -A && git commit -qm v1 && git remote add origin ${JSON.stringify(upstream)} && git push -q origin main`,
      seed,
    );
    sh(`git clone -q ${JSON.stringify(upstream)} cloned`, worktree);
    // Work in the clone: one commit, one uncommitted edit.
    const cloned = path.join(worktree, "cloned");
    fs.writeFileSync(path.join(cloned, "feature.ts"), "new\n");
    sh("git add -A && git commit -qm feature", cloned);
    fs.writeFileSync(path.join(cloned, "lib.ts"), "v2\n");

    const diff = await compute();
    const paths = diff.files.map((f) => f.path).sort();

    expect(paths).toEqual(["cloned/feature.ts", "cloned/lib.ts"]);
  });

  test("one broken nested repository costs its files, not the whole diff", async () => {
    initNested("api");
    write("api/committed.txt", "edit\n");
    write("base.txt", "parent edit\n");
    // A .git that is not a repository: discovery finds it, git refuses it.
    fs.mkdirSync(path.join(worktree, "corrupt/.git"), { recursive: true });

    const diff = await compute();
    const paths = diff.files.map((f) => f.path);

    expect(paths).toContain("api/committed.txt");
    expect(paths).toContain("base.txt");
  });
});
