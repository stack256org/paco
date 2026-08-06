import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CHATS_DIRNAME, REPO_DIRNAME } from "@paco/sandbox";
import { countLines, runHostCommand } from "./run-host-command";
import type { UnsavedWork } from "./types";

const GIT_TIMEOUT_MS = 30_000;

/**
 * Ask a workspace whether anything in it exists only here.
 *
 * This runs before anyone is offered the chance to delete a directory, because
 * a workspace is not disposable the way a container is: it holds the code the
 * agent wrote, and possibly commits that were never pushed anywhere.
 *
 * Three things are asked, in the session repository:
 *
 * - **Uncommitted files**, summed over the repository *and* every chat
 *   worktree. A chat's branch is checked out in its own directory, so a
 *   `git status` in the repository is blind to it — that is the mistake this
 *   sums over rather than avoids.
 * - **Unpushed commits**, as commits on any branch that no remote-tracking ref
 *   contains. With no remote configured, that is every commit, which is
 *   correct: nothing is backed up.
 * - **Tracked files**, so an operator can tell a real project from a workspace
 *   that was created and never used.
 *
 * Returns null when this is not a git repository at all, or when git could not
 * be run. Callers treat null as "assume there is work here".
 */
export async function probeUnsavedWork(
  workspacePath: string,
): Promise<UnsavedWork | null> {
  const repo = path.join(workspacePath, REPO_DIRNAME);

  const isRepo = await git(repo, ["rev-parse", "--git-dir"]);
  if (!isRepo.ok) {
    return null;
  }

  const [remotes, unpushed, tracked, repoStatus] = await Promise.all([
    git(repo, ["remote"]),
    // `--branches --not --remotes`: reachable from some local branch, from no
    // remote-tracking one. Fails in a repository with no commits, which is a
    // legitimate answer of zero rather than an error.
    git(repo, ["rev-list", "--branches", "--not", "--remotes", "--count"]),
    git(repo, ["ls-files"]),
    git(repo, ["status", "--porcelain"]),
  ]);

  let uncommittedFiles = repoStatus.ok ? countLines(repoStatus.stdout) : 0;

  for (const worktree of await listChatWorktrees(workspacePath)) {
    const status = await git(worktree, ["status", "--porcelain"]);
    if (status.ok) {
      uncommittedFiles += countLines(status.stdout);
    }
  }

  const unpushedCommits = unpushed.ok
    ? Number.parseInt(unpushed.stdout.trim(), 10)
    : 0;

  return {
    uncommittedFiles,
    unpushedCommits: Number.isFinite(unpushedCommits) ? unpushedCommits : 0,
    hasRemote: remotes.ok && remotes.stdout.trim().length > 0,
    trackedFiles: tracked.ok ? countLines(tracked.stdout) : 0,
  };
}

function git(cwd: string, args: string[]) {
  // `-C` rather than a `cwd` option so the path is one more ordinary argument
  // in the vector, never interpolated into anything.
  return runHostCommand("git", ["-C", cwd, ...args], GIT_TIMEOUT_MS);
}

async function listChatWorktrees(workspacePath: string): Promise<string[]> {
  const chatsDir = path.join(workspacePath, CHATS_DIRNAME);
  try {
    const entries = await fs.readdir(chatsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(chatsDir, entry.name));
  } catch {
    return [];
  }
}
