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
