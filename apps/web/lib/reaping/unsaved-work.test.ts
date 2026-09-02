/**
 * Real git, in throwaway workspaces — the point of this probe is what it can
 * actually see on disk, and a mocked git would only prove the mock.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { probeUnsavedWork } = await import("./unsaved-work");

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

/** A workspace with a repo, one chat worktree, and nothing uncommitted. */
async function makeWorkspace(): Promise<{ root: string; repo: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paco-unsaved-work-"));
  roots.push(root);

  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ["init", "-q"]);
  await git(repo, ["checkout", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "Initial commit"]);

  await git(repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    "chat/c1",
    path.join(root, "chats", "c1"),
  ]);

  return { root, repo };
}

async function addCandidateWorktree(
  root: string,
  repo: string,
  chatId: string,
  index: number,
): Promise<string> {
  const dir = path.join(root, "designs", chatId, String(index));
  await git(repo, [
    "worktree",
    "add",
    "-q",
    "-b",
    `design/${chatId}/${index}`,
    dir,
  ]);
  return dir;
}

describe("probeUnsavedWork", () => {
  test("counts uncommitted work in a leftover designs/ worktree", async () => {
    const { root, repo } = await makeWorkspace();
    const candidate = await addCandidateWorktree(root, repo, "c1", 2);
    await fs.writeFile(
      path.join(candidate, "hero.tsx"),
      "export const Hero = 1\n",
    );

    const work = await probeUnsavedWork(root);

    // Before this, `probeUnsavedWork` scanned `chats/` only, so a design
    // candidate holding the only copy of the user's work read as a clean
    // workspace — and the delete-session 409 safety gate let it go.
    expect(work?.uncommittedFiles).toBe(1);
  });

  test("sums candidate worktrees alongside the repo and the chat worktrees", async () => {
    const { root, repo } = await makeWorkspace();
    await fs.writeFile(path.join(repo, "repo-scratch.txt"), "x\n");
    await fs.writeFile(
      path.join(root, "chats", "c1", "chat-scratch.txt"),
      "x\n",
    );
    const one = await addCandidateWorktree(root, repo, "c1", 1);
    const two = await addCandidateWorktree(root, repo, "c1", 3);
    await fs.writeFile(path.join(one, "a.txt"), "x\n");
    await fs.writeFile(path.join(two, "b.txt"), "x\n");

    const work = await probeUnsavedWork(root);

    expect(work?.uncommittedFiles).toBe(4);
  });

  test("is unchanged for a workspace with no designs/ directory", async () => {
    const { root } = await makeWorkspace();

    const work = await probeUnsavedWork(root);

    expect(work?.uncommittedFiles).toBe(0);
    expect(work?.trackedFiles).toBe(1);
    expect(work?.hasRemote).toBe(false);
  });

  test("is not a git repository when there is no repo directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paco-unsaved-work-"));
    roots.push(root);

    expect(await probeUnsavedWork(root)).toBeNull();
  });
});

describe("counting uncommitted files", () => {
  test("counts every file in an untracked directory, not the directory", async () => {
    const { root, repo } = await makeWorkspace();

    // Plain `git status --porcelain` reports this as a single `?? src/`
    // line. An operator deciding whether to delete this workspace would have
    // been told it held one uncommitted file when it holds three.
    await fs.mkdir(path.join(repo, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "a.ts"), "a");
    await fs.writeFile(path.join(repo, "src", "b.ts"), "b");
    await fs.writeFile(path.join(repo, "src", "nested", "c.ts"), "c");

    const work = await probeUnsavedWork(root);

    expect(work?.uncommittedFiles).toBe(3);
  });

  test("still counts a plain modified file once", async () => {
    const { root, repo } = await makeWorkspace();

    await fs.writeFile(path.join(repo, "loose.txt"), "one");

    const work = await probeUnsavedWork(root);

    expect(work?.uncommittedFiles).toBe(1);
  });
});

describe("repositories nested inside the workspace", () => {
  /** `git init` a nested repository with one committed (unpushed) file. */
  async function initNested(parent: string, relative: string): Promise<string> {
    const dir = path.join(parent, relative);
    await fs.mkdir(dir, { recursive: true });
    await git(dir, ["init", "-q", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(dir, "committed.txt"), "committed\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-q", "-m", "nested work"]);
    return dir;
  }

  test("a gitignored nested repository full of work never reads as clean", async () => {
    const { root, repo } = await makeWorkspace();
    // The workspace-as-workspace pattern: the projects are gitignored in the
    // parent, so every question asked of the parent alone answers "clean".
    await fs.writeFile(path.join(repo, ".gitignore"), "projects/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-q", "-m", "ignore projects"]);
    const nested = await initNested(repo, "projects/api");
    await fs.writeFile(path.join(nested, "uncommitted.ts"), "x\n");

    const work = await probeUnsavedWork(root);

    // The parent's own two commits are unpushed too (it has no remote);
    // the third is the nested repository's — the one that was invisible.
    expect(work?.unpushedCommits).toBe(3);
    expect(work?.uncommittedFiles).toBeGreaterThanOrEqual(1);
  });

  test("a nested repository inside a chat worktree is probed too", async () => {
    const { root } = await makeWorkspace();
    const nested = await initNested(path.join(root, "chats", "c1"), "cloned");
    await fs.writeFile(path.join(nested, "scratch.ts"), "x\n");

    const work = await probeUnsavedWork(root);

    // The parent's initial commit plus the nested repository's one.
    expect(work?.unpushedCommits).toBe(2);
    // The worktree's own status counts `cloned/` as one untracked line, and
    // the nested probe counts the real file — both say "not disposable".
    expect(work?.uncommittedFiles).toBeGreaterThanOrEqual(1);
  });

  test("a fully pushed nested clone adds nothing", async () => {
    const { root, repo } = await makeWorkspace();
    const upstream = path.join(root, "upstream.git");
    await fs.mkdir(upstream);
    await git(upstream, ["init", "-q", "--bare", "-b", "main"]);
    const nested = await initNested(repo, "projects/api");
    await git(nested, ["remote", "add", "origin", upstream]);
    await git(nested, ["push", "-q", "origin", "main"]);

    const work = await probeUnsavedWork(root);

    // Only the parent's own initial commit: the pushed clone contributes 0.
    expect(work?.unpushedCommits).toBe(1);
    // The parent still sees the untracked `projects/` directory as one line —
    // that is the parent's own answer, not the nested repository's.
    expect(work?.uncommittedFiles).toBeLessThanOrEqual(1);
  });

  test("never walks into node_modules looking for repositories", async () => {
    const { root, repo } = await makeWorkspace();
    await initNested(repo, "node_modules/some-dep");

    const work = await probeUnsavedWork(root);

    // Only the parent's own initial commit — the repository buried in
    // node_modules was never probed.
    expect(work?.unpushedCommits).toBe(1);
  });
});
