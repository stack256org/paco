"use server";

import { chatBranchName, connectSandbox } from "@paco/sandbox";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { isSafeBranchName } from "@/lib/git/helpers";
import { GhError } from "@/lib/github/gh";
import {
  closePullRequest as closePrWithGh,
  createPullRequest,
  findPullRequest,
  mergePullRequest as mergePrWithGh,
} from "@/lib/github/gh-pr";
import { generatePullRequestContentFromSandbox } from "@/lib/github/pr-content";
import { isSandboxActive } from "@/lib/sandbox/utils";
import {
  SESSION_NOT_FOUND,
  GITHUB_NOT_CONNECTED,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";

/**
 * Pull request actions, on top of `gh`.
 *
 * Everything here is scoped to a *chat*, because that is what a branch belongs
 * to now: each chat has its own git worktree checked out on `chat/<chatId>`.
 * The GitHub App version of this file was 736 lines, most of it spent proving
 * the App was installed on the repository, minting a scoped token, and falling
 * back to a "open this URL yourself" flow when it turned out not to be. A token
 * either can push or cannot, and `gh` says which in its own error message.
 */

export type MergePullRequestResult = {
  merged: boolean;
  prNumber: number;
  mergeCommitSha: string | null;
  branchDeleted: boolean;
  branchDeleteError: string | null;
};

export type ClosePullRequestResult = {
  closed: boolean;
  prNumber: number;
};

export interface GeneratePrContentResult {
  title?: string;
  body?: string;
  branchName?: string;
  error?: string;
}

export type OpenPullRequestResult = {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  prStatus?: string;
  error?: string;
};

type ChatContext = {
  token: string;
  sessionId: string;
  cwd: string;
  branch: string;
  baseBranch: string;
};

/**
 * Everything a pull-request action needs, resolved once.
 *
 * Throws rather than returning a result union: these are server actions called
 * from dialogs that already catch and display errors, and a thrown message is
 * what those dialogs show.
 */
async function resolveChat(params: {
  sessionId: string;
  chatId: string;
}): Promise<ChatContext> {
  const sessionRecord = await getSessionById(params.sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }
  if (!sessionRecord.repoName) {
    throw new Error(
      "This workspace has no GitHub repository yet. Create one first.",
    );
  }

  const token = await getGithubToken();
  if (!token) {
    throw new Error(GITHUB_NOT_CONNECTED);
  }

  return {
    token,
    sessionId: params.sessionId,
    // `gh` reads the repository from its working directory, and only the
    // chat's worktree has the chat's branch checked out.
    cwd: hostChatWorktree(sessionRecord.sandboxState, params.chatId),
    branch: chatBranchName(params.chatId),
    baseBranch: sessionRecord.branch ?? "main",
  };
}

/**
 * `GhError` messages are already written for a person (see
 * `gh-failure-copy`), so they pass through; anything else could be any thrown
 * string at all and gets a sentence that at least says what to do.
 */
function describe(error: unknown): string {
  if (error instanceof GhError) {
    return error.message;
  }
  return "We couldn't finish that on GitHub. Try again in a moment.";
}

export async function generatePrContent(params: {
  sessionId: string;
  chatId: string;
  sessionTitle: string;
  baseBranch: string;
}): Promise<GeneratePrContentResult> {
  const sessionRecord = await getSessionById(params.sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }
  if (!params.baseBranch || !isSafeBranchName(params.baseBranch)) {
    throw new Error("That branch name can't be used. Pick a different one.");
  }

  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  const cwd = hostChatWorktree(sessionRecord.sandboxState, params.chatId);
  const branchName = chatBranchName(params.chatId);

  const status = await sandbox.exec("git status --porcelain", cwd, 10_000);
  if (status.stdout.trim().length > 0) {
    throw new Error(
      "You have unsaved changes. Commit them first, then write the pull request.",
    );
  }

  // Fetch so the base ref exists locally; without it the diff below has
  // nothing to compare against on a freshly cloned worktree.
  await sandbox.exec(
    `git fetch origin ${params.baseBranch}:refs/remotes/origin/${params.baseBranch}`,
    cwd,
    30_000,
  );

  const originRef = await sandbox.exec(
    `git rev-parse --verify origin/${params.baseBranch}`,
    cwd,
    10_000,
  );
  const baseRef = originRef.success
    ? `origin/${params.baseBranch}`
    : params.baseBranch;

  const content = await generatePullRequestContentFromSandbox({
    sandbox,
    sessionId: params.sessionId,
    sessionTitle: params.sessionTitle,
    baseBranch: params.baseBranch,
    branchName,
    baseRef,
    ...(process.env.APP_URL ? { appBaseUrl: process.env.APP_URL } : {}),
    cwd,
  });

  if (!content.success) {
    return { error: content.error };
  }

  return { title: content.title, body: content.body, branchName };
}

export async function openPullRequest(params: {
  sessionId: string;
  chatId: string;
  title: string;
  body?: string;
  baseBranch: string;
  isDraft?: boolean;
}): Promise<OpenPullRequestResult> {
  const context = await resolveChat(params);

  if (!isSafeBranchName(params.baseBranch)) {
    throw new Error("That branch name can't be used. Pick a different one.");
  }

  try {
    const pullRequest = await createPullRequest({
      token: context.token,
      cwd: context.cwd,
      base: params.baseBranch,
      head: context.branch,
      title: params.title,
      ...(params.body ? { body: params.body } : {}),
      draft: params.isDraft ?? false,
    });

    await updateSession(context.sessionId, {
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
    });

    return {
      success: true,
      prUrl: pullRequest.url,
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
    };
  } catch (error) {
    return { success: false, error: describe(error) };
  }
}

export async function mergePr(params: {
  sessionId: string;
  chatId: string;
  mergeMethod: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
}): Promise<MergePullRequestResult> {
  const context = await resolveChat(params);

  const existing = await findPullRequest({
    token: context.token,
    cwd: context.cwd,
    branch: context.branch,
  });
  if (!existing) {
    throw new Error("This chat has no open pull request. Open one first.");
  }

  const merged = await mergePrWithGh({
    token: context.token,
    cwd: context.cwd,
    number: existing.number,
    method: params.mergeMethod,
    ...(params.deleteBranch ? { deleteBranch: true } : {}),
  });

  await updateSession(context.sessionId, {
    prNumber: merged.number,
    prStatus: merged.state,
  });

  return {
    merged: merged.state === "merged",
    prNumber: merged.number,
    // `gh pr merge` does not report the merge commit, and nothing in the UI
    // uses it beyond displaying it, so it is deliberately not fetched.
    mergeCommitSha: null,
    branchDeleted: params.deleteBranch === true,
    branchDeleteError: null,
  };
}

export async function closePr(params: {
  sessionId: string;
  chatId: string;
}): Promise<ClosePullRequestResult> {
  const context = await resolveChat(params);

  const existing = await findPullRequest({
    token: context.token,
    cwd: context.cwd,
    branch: context.branch,
  });
  if (!existing) {
    throw new Error("This chat has no open pull request. Open one first.");
  }

  const closed = await closePrWithGh({
    token: context.token,
    cwd: context.cwd,
    number: existing.number,
  });

  await updateSession(context.sessionId, {
    prNumber: closed.number,
    prStatus: closed.state,
  });

  return { closed: closed.state === "closed", prNumber: closed.number };
}
