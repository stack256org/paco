import "server-only";

import { chatBranchName, type Sandbox } from "@paco/sandbox";
import { getGithubToken } from "@/lib/db/github-tokens";
import { GhError, git } from "@/lib/github/gh";
import { generateCommitMessage } from "@/lib/github/commit-message";
import { shellQuote } from "@/lib/shell/quote";

const AUTO_COMMIT_FAILED =
  "We couldn't save these changes. Open the changes panel and commit them yourself.";

const NO_GITHUB_CONNECTION =
  "Saved on this machine. Connect your GitHub account in Settings to send it to GitHub.";

const PUSH_FAILED =
  "Saved on this machine, but we couldn't send it to GitHub. Try again in a moment.";

/**
 * Save a turn's work, without asking.
 *
 * Previously built a *verified* commit through the GitHub API — a blob upload
 * per changed file, then a tree, then a commit object, then a ref move — and
 * afterwards reset the sandbox to match the new remote HEAD, because the local
 * working copy had played no part in creating the commit it now had to agree
 * with.
 *
 * `git commit` and `git push` do the same job from the worktree that already
 * holds the work, so there is nothing to reconcile afterwards. The commit is no
 * longer marked verified, which is a real loss and an honest one: signing needs
 * a key Paco does not have.
 *
 * Committing and pushing are two steps, not one, because they carry different
 * risks. A commit writes local history and can always be undone by the person
 * who owns the machine; a push publishes to someone's GitHub account. So a
 * session with no repository still commits, and a push that fails leaves the
 * commit exactly where it is rather than unwinding it.
 */

export interface AutoCommitParams {
  sandbox: Sandbox;
  userId: string;
  sessionId: string;
  chatId: string;
  sessionTitle: string;
  /**
   * Send the commit to GitHub afterwards. Off means the work stays on this
   * machine — the default, and the only possibility without a repository.
   */
  push: boolean;
  /** Absent for a session that was never connected to a GitHub repository. */
  repoOwner?: string;
  repoName?: string;
  /** Where the chat's worktree lives on disk. */
  cwd: string;
}

export interface AutoCommitResult {
  committed: boolean;
  pushed: boolean;
  commitMessage?: string;
  commitSha?: string;
  error?: string;
}

const PUSH_TIMEOUT_MS = 180_000;

/** How many changed paths to name before the message gets unreadable. */
const MAX_NAMED_PATHS = 3;

/**
 * A commit subject for when the model could not write one.
 *
 * "chore: update" tells a reader nothing they could not have guessed, and this
 * history exists so a non-technical owner can find the point they want to go
 * back to. The changed paths are already known here, so say them.
 */
export function buildFallbackCommitMessage(
  porcelainStatus: string,
  sessionTitle: string,
): string {
  const paths = porcelainStatus
    .split("\n")
    .map((line) => line.slice(3).trim())
    // A rename reads as "old -> new"; the destination is the useful half.
    .map((path) => path.split(" -> ").at(-1) ?? path)
    .filter((path) => path.length > 0);

  if (paths.length === 0) {
    return `Save work from ${sessionTitle}`;
  }

  const named = paths.slice(0, MAX_NAMED_PATHS).join(", ");
  const remaining = paths.length - MAX_NAMED_PATHS;

  return remaining > 0
    ? `Update ${named} and ${remaining} more`
    : `Update ${named}`;
}

interface CommitOutcome {
  committed: boolean;
  commitMessage?: string;
  commitSha?: string;
  error?: string;
}

async function commitWorktree(
  params: AutoCommitParams,
): Promise<CommitOutcome> {
  const { sandbox, cwd } = params;

  const status = await sandbox.exec("git status --porcelain", cwd, 30_000);
  if (!status.success) {
    console.error("[auto-commit] git status failed:", status.stderr);
    return { committed: false, error: AUTO_COMMIT_FAILED };
  }
  if (status.stdout.trim().length === 0) {
    // A turn that only answered a question. Nothing to save is not a failure.
    return { committed: false };
  }

  const staged = await sandbox.exec("git add -A", cwd, 60_000);
  if (!staged.success) {
    console.error("[auto-commit] git add failed:", staged.stderr);
    return { committed: false, error: AUTO_COMMIT_FAILED };
  }

  // The message is written from the staged diff, so it has to be read after
  // staging and before committing.
  const diff = await sandbox.exec("git diff --cached", cwd, 60_000);
  const generated = await generateCommitMessage(
    diff.stdout,
    params.sessionTitle,
  );
  const commitMessage =
    generated.trim().length > 0
      ? generated
      : buildFallbackCommitMessage(status.stdout, params.sessionTitle);

  // `shellQuote`, not `JSON.stringify`: this message is written by the model
  // and committed without anyone reading it first, and the command runs through
  // `bash -lc`. Double quotes would let a backtick in the message execute, and
  // would flatten the body onto the subject line.
  const committed = await sandbox.exec(
    `git commit -m ${shellQuote(commitMessage)}`,
    cwd,
    60_000,
  );
  if (!committed.success) {
    console.error("[auto-commit] git commit failed:", committed.stderr);
    return { committed: false, error: AUTO_COMMIT_FAILED };
  }

  const sha = await sandbox.exec("git rev-parse HEAD", cwd, 15_000);
  const commitSha = sha.success ? sha.stdout.trim() : undefined;

  return {
    committed: true,
    commitMessage,
    ...(commitSha ? { commitSha } : {}),
  };
}

/**
 * Send the chat's branch to GitHub.
 *
 * Returns the reason it could not, never throws: by the time this runs the
 * commit already exists, and no push failure is worth losing it over.
 */
async function pushChatBranch(
  params: AutoCommitParams,
): Promise<string | null> {
  const token = await getGithubToken(params.userId);
  if (!token) {
    return NO_GITHUB_CONNECTION;
  }

  try {
    await git(
      ["push", "--set-upstream", "origin", chatBranchName(params.chatId)],
      { token, cwd: params.cwd, timeoutMs: PUSH_TIMEOUT_MS },
    );
    return null;
  } catch (error) {
    return error instanceof GhError ? error.message : PUSH_FAILED;
  }
}

export async function performAutoCommit(
  params: AutoCommitParams,
): Promise<AutoCommitResult> {
  const commit = await commitWorktree(params);

  if (!commit.committed) {
    return {
      committed: false,
      pushed: false,
      ...(commit.error ? { error: commit.error } : {}),
    };
  }

  const commitDetails = {
    ...(commit.commitMessage ? { commitMessage: commit.commitMessage } : {}),
    ...(commit.commitSha ? { commitSha: commit.commitSha } : {}),
  };

  if (!params.push) {
    return { committed: true, pushed: false, ...commitDetails };
  }

  const pushError = await pushChatBranch(params);

  return {
    committed: true,
    pushed: pushError === null,
    ...commitDetails,
    ...(pushError ? { error: pushError } : {}),
  };
}
