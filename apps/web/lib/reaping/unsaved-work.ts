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
 * - **Uncommitted files**, summed over the repository *and* every worktree
 *   under it — chat worktrees (`chats/<chatId>/`) and design-candidate
 *   worktrees (`designs/<chatId>/<n>/`) alike. A branch checked out in its own
 *   directory is invisible to a `git status` in the repository, so each one is
 *   asked directly. Candidates were missed here at first, which meant a design
 *   candidate holding the only copy of what the user asked for read as a clean
 *   workspace and the delete-session safety gate let it go.
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

  for (const worktree of await listWorktrees(workspacePath)) {
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

/**
 * Directory holding design-candidate worktrees, relative to the workspace
 * root.
 *
 * A local literal rather than an import: `@paco/sandbox`'s layout module
 * exports `REPO_DIRNAME` and `CHATS_DIRNAME` but has never had a name for
 * this one, and `lib/preview/nginx-reload.ts` already keeps its own copy for
 * the same reason. The layout (`designs/<chatId>/<n>/`, a sibling of
 * `chats/<chatId>/`) is fixed by the workspace-layout doc.
 */
const DESIGNS_DIRNAME = "designs";

/** Every immediate subdirectory of `parent`, as absolute paths. */
async function subdirectories(parent: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

/**
 * Every worktree directory in a workspace, whichever kind it is.
 *
 * Chat worktrees sit one level under `chats/`; design-candidate worktrees sit
 * two levels under `designs/` (`designs/<chatId>/<n>/`), which is why this
 * cannot be one `readdir`. A candidate's directory is only reported when it
 * looks like a real worktree — `git status` in a stray empty directory would
 * answer for the repository it happens to be inside and double-count it.
 */
async function listWorktrees(workspacePath: string): Promise<string[]> {
  const chatWorktrees = await subdirectories(
    path.join(workspacePath, CHATS_DIRNAME),
  );

  const candidateWorktrees: string[] = [];
  for (const chatDesigns of await subdirectories(
    path.join(workspacePath, DESIGNS_DIRNAME),
  )) {
    for (const candidate of await subdirectories(chatDesigns)) {
      // A worktree's `.git` is a pointer *file* back into
      // `repo/.git/worktrees/<id>`, not a directory — either way, its
      // presence is what distinguishes a worktree from a leftover directory.
      try {
        await fs.stat(path.join(candidate, ".git"));
        candidateWorktrees.push(candidate);
      } catch {
        // Not a worktree (half-removed, or never created properly).
      }
    }
  }

  return [...chatWorktrees, ...candidateWorktrees];
}
