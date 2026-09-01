import "server-only";

import { chatBranchName, type Sandbox } from "@paco/sandbox";
import { getGithubToken } from "@/lib/db/github-tokens";
import { updateSession } from "@/lib/db/sessions";
import { GhError, git } from "@/lib/github/gh";
import { createPullRequest, findPullRequest } from "@/lib/github/gh-pr";
import { generatePullRequestContentFromSandbox } from "@/lib/github/pr-content";

/**
 * Open a pull request after a turn, without asking.
 *
 * The App version had to prove the App was installed on the repository, mint a
 * scoped installation token, look up the default branch, and fall back to
 * handing the user a "compare" URL to finish by hand when any of that failed.
 * `gh pr create` needs a token and a pushed branch.
 *
 * An existing pull request is left alone rather than replaced: the branch is
 * pushed so the pull request picks up the new commits, which is what "sync"
 * meant before and is all GitHub needs.
 */

export interface AutoCreatePrParams {
  sandbox: Sandbox;
  sessionId: string;
  chatId: string;
  sessionTitle: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  /** Where the chat's worktree lives on disk. */
  cwd: string;
}

export interface AutoCreatePrResult {
  created: boolean;
  syncedExisting: boolean;
  skipped: boolean;
  skipReason?: string;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

const PUSH_TIMEOUT_MS = 180_000;

export async function performAutoCreatePr(
  params: AutoCreatePrParams,
): Promise<AutoCreatePrResult> {
  const { sandbox, cwd } = params;
  const branch = chatBranchName(params.chatId);

  const token = await getGithubToken();
  if (!token) {
    return {
      created: false,
      syncedExisting: false,
      skipped: true,
      skipReason: "GitHub is not connected",
    };
  }

  /*
   * Nothing to open a pull request about is now the *ordinary* case, not the
   * exception: turns do not commit, so a branch is only ahead of its base once
   * the operator has committed something themselves.
   *
   * An unreadable count skips too. It used to fall through and open the pull
   * request anyway, on the theory that a failed check should not block a real
   * proposal — but the check only fails when `origin/<base>` does not exist,
   * and a base branch GitHub has never seen is not one a pull request can
   * target. Falling through there produced an empty or impossible PR.
   */
  const ahead = await sandbox.exec(
    `git rev-list --count origin/${params.baseBranch}..HEAD`,
    cwd,
    30_000,
  );
  if (!ahead.success || ahead.stdout.trim() === "0") {
    return {
      created: false,
      syncedExisting: false,
      skipped: true,
      // Kept short deliberately: `git-data-part-card.tsx` renders a skip
      // reason as a single truncated line, so a sentence loses its ending —
      // which is where the instruction lives.
      skipReason: ahead.success
        ? "Nothing committed yet — commit to open a pull request"
        : `Couldn't compare this branch with ${params.baseBranch}`,
    };
  }

  try {
    await git(["push", "--set-upstream", "origin", branch], {
      token,
      cwd,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      created: false,
      syncedExisting: false,
      skipped: false,
      error:
        error instanceof GhError
          ? error.message
          : "We couldn't send your changes to GitHub. Try again in a moment.",
    };
  }

  const existing = await findPullRequest({ token, cwd, branch }).catch(
    () => null,
  );
  if (existing && existing.state === "open") {
    // The push above already updated it; GitHub needs nothing else.
    return {
      created: false,
      syncedExisting: true,
      skipped: false,
      prNumber: existing.number,
      prUrl: existing.url,
    };
  }

  const content = await generatePullRequestContentFromSandbox({
    sandbox,
    sessionId: params.sessionId,
    sessionTitle: params.sessionTitle,
    baseBranch: params.baseBranch,
    branchName: branch,
    baseRef: `origin/${params.baseBranch}`,
    cwd,
  });

  try {
    const pullRequest = await createPullRequest({
      token,
      cwd,
      base: params.baseBranch,
      head: branch,
      title: content.success ? content.title : params.sessionTitle,
      ...(content.success && content.body ? { body: content.body } : {}),
    });

    await updateSession(params.sessionId, {
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
    });

    return {
      created: true,
      syncedExisting: false,
      skipped: false,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
    };
  } catch (error) {
    return {
      created: false,
      syncedExisting: false,
      skipped: false,
      error:
        error instanceof GhError
          ? error.message
          : "We couldn't open the pull request. Try again in a moment.",
    };
  }
}
