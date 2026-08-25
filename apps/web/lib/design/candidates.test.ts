/**
 * Real git, in throwaway repos under a tmp dir — no mocking of `git` itself,
 * since the whole point of this module is what actually happens on disk:
 * worktrees appearing at declared paths, branches existing, a merge landing
 * on the chat's branch.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { createCandidates, removeCandidates, acceptCandidate } =
  await import("./candidates");

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  root: string;
  repo: string;
  chatId: string;
  chatBranch: string;
  chatWorktree: string;
}

let fixtures: Fixture[] = [];

/**
 * A session workspace with a repo on `main` and a chat worktree branched off
 * it with one commit of its own — the shape `createCandidates` and
 * `acceptCandidate` are actually handed in production.
 */
async function makeFixture(chatId: string): Promise<Fixture> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "paco-design-candidates-"),
  );
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });

  await git(repo, ["init", "-q"]);
  await git(repo, ["checkout", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "Initial commit"]);

  const chatBranch = `chat/${chatId}`;
  const chatWorktree = path.join(root, "chats", chatId);
  await git(repo, ["worktree", "add", "-q", "-b", chatBranch, chatWorktree]);
  await fs.writeFile(path.join(chatWorktree, "chat.txt"), "chat work\n");
  await git(chatWorktree, ["add", "."]);
  await git(chatWorktree, ["config", "user.email", "test@example.com"]);
  await git(chatWorktree, ["config", "user.name", "Test"]);
  await git(chatWorktree, ["commit", "-q", "-m", "Chat work"]);

  const fixture = { root, repo, chatId, chatBranch, chatWorktree };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => {
  fixtures = [];
});

afterEach(async () => {
  await Promise.all(
    fixtures.map((fixture) =>
      fs.rm(fixture.root, { recursive: true, force: true }),
    ),
  );
});

describe("createCandidates", () => {
  test("creates a worktree and branch per candidate, branched from the chat's branch", async () => {
    const { root, repo, chatId, chatBranch } = await makeFixture("abc123");

    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 3,
    });

    expect(candidates).toHaveLength(3);

    for (const candidate of candidates) {
      expect(candidate.branch).toBe(`design/${chatId}/${candidate.index}`);
      expect(candidate.worktreeDir).toBe(
        path.join(root, "designs", chatId, String(candidate.index)),
      );
      expect(await exists(candidate.worktreeDir)).toBe(true);

      const head = (
        await git(candidate.worktreeDir, ["symbolic-ref", "--short", "HEAD"])
      ).trim();
      expect(head).toBe(candidate.branch);

      // Branched from the chat's branch, not the repo's default branch.
      expect(await exists(path.join(candidate.worktreeDir, "chat.txt"))).toBe(
        true,
      );

      const branchList = await git(repo, [
        "branch",
        "--list",
        candidate.branch,
      ]);
      expect(branchList.trim()).not.toBe("");
    }
  });
});

describe("removeCandidates", () => {
  test("is safe when no candidates exist", async () => {
    const { root, chatId } = await makeFixture("none");

    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();
  });

  test("removes worktrees and branches, and is idempotent", async () => {
    const { root, repo, chatId } = await makeFixture("cleanup1");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    await removeCandidates({ sessionWorkspace: root, chatId });

    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");

    // Calling again must not throw, and must leave the same clean state.
    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();
    const worktreeList = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktreeList).not.toContain(path.join("designs", chatId));
  });

  test("tolerates a candidate directory deleted by hand before cleanup", async () => {
    const { root, repo, chatId } = await makeFixture("cleanup2");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: `chat/${chatId}`,
      count: 2,
    });

    const half = candidates[1];
    if (!half) {
      throw new Error("expected two candidates");
    }
    // Simulate a worktree directory that vanished without `git worktree
    // remove` being told (e.g. an interrupted cleanup, or manual deletion).
    await fs.rm(half.worktreeDir, { recursive: true, force: true });

    await expect(
      removeCandidates({ sessionWorkspace: root, chatId }),
    ).resolves.toBeUndefined();

    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");
  });
});

describe("acceptCandidate", () => {
  test("merges the candidate's commit onto the chat branch and cleans up", async () => {
    const { root, repo, chatId, chatBranch, chatWorktree } =
      await makeFixture("accept1");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    const winner = candidates[0];
    if (!winner) {
      throw new Error("expected at least one candidate");
    }

    await fs.writeFile(
      path.join(winner.worktreeDir, "feature.txt"),
      "the winning design\n",
    );
    await git(winner.worktreeDir, ["add", "."]);
    await git(winner.worktreeDir, ["config", "user.email", "test@example.com"]);
    await git(winner.worktreeDir, ["config", "user.name", "Test"]);
    await git(winner.worktreeDir, ["commit", "-q", "-m", "Candidate change"]);

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: winner.index,
      chatBranch,
    });

    expect(result.ok).toBe(true);
    expect(await exists(path.join(chatWorktree, "feature.txt"))).toBe(true);

    const subject = (
      await git(chatWorktree, ["log", "-1", "--format=%s"])
    ).trim();
    expect(subject).toBe(`Adopt design candidate ${winner.index}`);

    // Accepting cleans up every candidate, not just the winner.
    for (const candidate of candidates) {
      expect(await exists(candidate.worktreeDir)).toBe(false);
    }
    const branchList = await git(repo, [
      "branch",
      "--list",
      `design/${chatId}/*`,
    ]);
    expect(branchList.trim()).toBe("");
  });

  test("refuses when the chat worktree is dirty, naming it", async () => {
    const { root, chatId, chatBranch, chatWorktree } =
      await makeFixture("accept2");
    const candidates = await createCandidates({
      sessionWorkspace: root,
      chatId,
      baseBranch: chatBranch,
      count: 2,
    });
    const winner = candidates[0];
    if (!winner) {
      throw new Error("expected at least one candidate");
    }

    // Uncommitted work in the chat's own worktree.
    await fs.writeFile(
      path.join(chatWorktree, "uncommitted.txt"),
      "not committed\n",
    );

    const result = await acceptCandidate({
      sessionWorkspace: root,
      chatId,
      index: winner.index,
      chatBranch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected acceptCandidate to refuse");
    }
    expect(result.error).toContain(chatWorktree);
    expect(result.error.toLowerCase()).toContain("uncommitted");

    // Refused, so nothing was cleaned up.
    expect(await exists(winner.worktreeDir)).toBe(true);
  });
});
