"use server";

import { chatBranchName, connectSandbox } from "@paco/sandbox";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSessionById } from "@/lib/db/sessions";
import { GhError, git } from "@/lib/github/gh";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { shellQuote } from "@/lib/shell/quote";
import { SESSION_NOT_FOUND, WORKSPACE_NOT_STARTED } from "@/lib/error-copy";

/**
 * Commit and push a chat's changes.
 *
 * The GitHub App version did this through the REST API: read every changed
 * file, upload each as a blob, assemble a tree, create a commit object, then
 * move the ref — several hundred lines, and a round trip per file, in exchange
 * for GitHub's "Verified" badge on the commit.
 *
 * It is plain `git commit` and `git push` now. The work is already on disk in
 * the chat's worktree, git is already installed, and the same credential helper
 * that authenticates `gh` authenticates the push. The commit loses its verified
 * badge, which is the honest trade: signing needs a key Paco does not have and
 * should not be asking users for.
 */

export interface CommitResult {
  committed: boolean;
  pushed: boolean;
  branchName?: string;
  commitMessage?: string;
  commitSha?: string;
  error?: string;
}

const GIT_TIMEOUT_MS = 120_000;

const COMMIT_FAILED =
  "We couldn't save your changes. Reload the page and try again.";

function failure(error: string): CommitResult {
  return { committed: false, pushed: false, error };
}

export async function commitChanges(params: {
  sessionId: string;
  chatId: string;
  commitTitle?: string;
  commitBody?: string;
}): Promise<CommitResult> {
  const sessionRecord = await getSessionById(params.sessionId);
  if (!sessionRecord) {
    return failure(SESSION_NOT_FOUND);
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return failure(WORKSPACE_NOT_STARTED);
  }

  const cwd = hostChatWorktree(sessionRecord.sandboxState, params.chatId);
  const branchName = chatBranchName(params.chatId);
  const message = [params.commitTitle?.trim() || "Update from Paco"]
    .concat(params.commitBody?.trim() ? ["", params.commitBody.trim()] : [])
    .join("\n");

  // Staging and committing need no credentials, so they go through the sandbox
  // like every other git operation. Only the push needs a token.
  const sandbox = await connectSandbox(sessionRecord.sandboxState);

  const status = await sandbox.exec("git status --porcelain", cwd, 30_000);
  if (status.stdout.trim().length === 0) {
    return failure("There's nothing to commit — no files have changed.");
  }

  const staged = await sandbox.exec("git add -A", cwd, 60_000);
  if (!staged.success) {
    console.error("[commit] git add failed:", staged.stderr);
    return failure(COMMIT_FAILED);
  }

  // `shellQuote`, not `JSON.stringify`: `sandbox.exec` runs `bash -lc`, so a
  // double-quoted message keeps `$(…)` and backticks live and turns the blank
  // line before the body into a literal `\n`.
  const committed = await sandbox.exec(
    `git commit -m ${shellQuote(message)}`,
    cwd,
    60_000,
  );
  if (!committed.success) {
    console.error("[commit] git commit failed:", committed.stderr);
    return failure(COMMIT_FAILED);
  }

  const sha = await sandbox.exec("git rev-parse HEAD", cwd, 15_000);
  const commitSha = sha.success ? sha.stdout.trim() : undefined;

  // A workspace with no GitHub repository is a perfectly valid place to
  // commit; there is simply nowhere to push it.
  if (!sessionRecord.repoName) {
    return {
      committed: true,
      pushed: false,
      branchName,
      commitMessage: message,
      ...(commitSha ? { commitSha } : {}),
    };
  }

  const token = await getGithubToken();
  if (!token) {
    return {
      committed: true,
      pushed: false,
      branchName,
      commitMessage: message,
      ...(commitSha ? { commitSha } : {}),
      error:
        "Saved on this machine. Connect your GitHub account in Settings to send it to GitHub.",
    };
  }

  try {
    await git(["push", "--set-upstream", "origin", branchName], {
      token,
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      committed: true,
      pushed: false,
      branchName,
      commitMessage: message,
      ...(commitSha ? { commitSha } : {}),
      error:
        error instanceof GhError
          ? error.message
          : "Saved on this machine, but we couldn't send it to GitHub. Try again in a moment.",
    };
  }

  return {
    committed: true,
    pushed: true,
    branchName,
    commitMessage: message,
    ...(commitSha ? { commitSha } : {}),
  };
}
