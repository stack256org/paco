"use server";

import { chatBranchName } from "@paco/sandbox";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSessionById } from "@/lib/db/sessions";
import { findPullRequest } from "@/lib/github/gh-pr";
import {
  checksFailingBlocker,
  checksRunningBlocker,
  githubUnavailableBlocker,
  mergeBlocker,
  type MergeBlocker,
} from "@/lib/github/merge-blockers";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
import { NOT_YOURS, SESSION_NOT_FOUND, SIGNED_OUT } from "@/lib/error-copy";

/**
 * Pull request state for the UI, read through `gh`.
 *
 * The App version asked the REST API for merge readiness, branch protection,
 * required reviews, and check runs across four calls, each needing an
 * installation token scoped to the repository. `gh pr view --json` answers all
 * of it in one, as the user, with no installation to verify.
 */

export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * A check's outcome in the three terms the UI groups by.
 *
 * Derived here rather than in the component, because deciding that "queued"
 * and "in_progress" and a missing conclusion all mean *pending* is a fact
 * about GitHub's API, not about how a list is rendered.
 */
export type CheckState = "passed" | "failed" | "pending";

export type CheckRun = {
  /** GitHub's check-run id, needed to fetch that run's annotations and logs. */
  id: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  state: CheckState;
  detailsUrl: string | null;
};

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ERROR",
  "ACTION_REQUIRED",
]);

function toCheckState(conclusion: string | null, status: string): CheckState {
  const outcome = (conclusion ?? status).toUpperCase();
  if (PASSED.has(outcome)) {
    return "passed";
  }
  if (FAILED.has(outcome)) {
    return "failed";
  }
  return "pending";
}

type MergeReadinessChecks = {
  total: number;
  passed: number;
  pending: number;
  failed: number;
  /** Kept for the UI's "N of M required" line; GitHub's rollup has no such split. */
  requiredTotal: number;
};

export type MergeReadinessResponse = {
  canMerge: boolean;
  /**
   * Why the merge is blocked, each with a code the UI branches on.
   *
   * Not `string[]`: see `lib/github/merge-blockers.ts` for what matching on
   * the sentences cost.
   */
  blockers: MergeBlocker[];
  pr: {
    number: number;
    repo: string;
    title: string | null;
    body: string | null;
    baseBranch: string | null;
    headBranch: string | null;
    headSha: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    commits: number;
  } | null;
  allowedMethods: MergeMethod[];
  defaultMethod: MergeMethod;
  checks: MergeReadinessChecks;
  checkRuns: CheckRun[];
};

const EMPTY_CHECKS: MergeReadinessChecks = {
  total: 0,
  passed: 0,
  pending: 0,
  failed: 0,
  requiredTotal: 0,
};

/**
 * Every method is offered.
 *
 * Which of squash, merge, and rebase a repository actually permits is a branch
 * protection setting, and reading it needs admin access the token may not have.
 * `gh pr merge` reports a disallowed method clearly enough, so the choice is
 * left to the user rather than hidden behind a permission Paco cannot check.
 */
const ALL_METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

/**
 * How `gh pr view` reports the branch simply not having a pull request.
 *
 * The only failure that is not a failure: it is the answer for every chat
 * before its first pull request is opened.
 */
const NO_PULL_REQUEST = /no (?:open )?pull requests? found/i;

/** For a throw that is not an `Error` at all, so has no message to show. */
const GH_UNKNOWN_FAILURE =
  "We couldn't check this pull request with GitHub. Try again in a moment.";

async function resolve(sessionId: string, chatId: string) {
  const authSession = await getServerSession();
  if (!authSession?.user) {
    throw new Error(SIGNED_OUT);
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (sessionRecord.userId !== authSession.user.id) {
    throw new Error(NOT_YOURS);
  }

  return { authSession, sessionRecord, chatId };
}

/** The chat's pull request, falling back to what the session already recorded. */
export async function checkPullRequest(params: {
  sessionId: string;
  chatId: string;
}): Promise<{
  branch: string | null;
  prNumber: number | null;
  prStatus: "open" | "merged" | "closed" | null;
}> {
  const { sessionRecord } = await resolve(params.sessionId, params.chatId);

  const cached = {
    branch: sessionRecord.branch ?? null,
    prNumber: sessionRecord.prNumber ?? null,
    prStatus: sessionRecord.prStatus ?? null,
  };

  if (!isSandboxActive(sessionRecord.sandboxState) || !sessionRecord.repoName) {
    return cached;
  }

  const token = await getGithubToken(sessionRecord.userId);
  if (!token) {
    return cached;
  }

  try {
    const pullRequest = await findPullRequest({
      token,
      cwd: hostChatWorktree(sessionRecord.sandboxState, params.chatId),
      branch: chatBranchName(params.chatId),
    });

    if (!pullRequest) {
      return { ...cached, prNumber: null, prStatus: null };
    }

    return {
      branch: pullRequest.headBranch,
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
    };
  } catch {
    // A stopped sandbox or a network blip. The cached values are still the
    // best answer available.
    return cached;
  }
}

export async function getMergeReadiness(params: {
  sessionId: string;
  chatId: string;
}): Promise<MergeReadinessResponse> {
  const { sessionRecord } = await resolve(params.sessionId, params.chatId);

  const empty: MergeReadinessResponse = {
    canMerge: false,
    blockers: [],
    pr: null,
    allowedMethods: ALL_METHODS,
    defaultMethod: "squash",
    checks: EMPTY_CHECKS,
    checkRuns: [],
  };

  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return { ...empty, blockers: [mergeBlocker("workspace-not-running")] };
  }
  if (!sessionRecord.repoName) {
    return { ...empty, blockers: [mergeBlocker("no-repository")] };
  }

  const token = await getGithubToken(sessionRecord.userId);
  if (!token) {
    return { ...empty, blockers: [mergeBlocker("github-not-connected")] };
  }

  const { GhError, ghJson } = await import("@/lib/github/gh");
  const cwd = hostChatWorktree(sessionRecord.sandboxState, params.chatId);
  const branch = chatBranchName(params.chatId);

  type DetailedPr = {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    baseRefName?: unknown;
    headRefName?: unknown;
    headRefOid?: unknown;
    additions?: unknown;
    deletions?: unknown;
    changedFiles?: unknown;
    commits?: unknown;
    mergeable?: unknown;
    state?: unknown;
    isDraft?: unknown;
    statusCheckRollup?: unknown;
  };

  let view: DetailedPr;
  try {
    view = await ghJson<DetailedPr>(
      [
        "pr",
        "view",
        branch,
        "--json",
        "number,title,body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,commits,mergeable,state,isDraft,statusCheckRollup",
      ],
      { token, cwd },
    );
  } catch (error) {
    /*
     * A branch with no pull request is the ordinary case; everything else is
     * a failure with its own explanation.
     *
     * This used to be a bare `catch` that answered "this chat has no open
     * pull request" to all of them — a missing `gh` CLI, a revoked token, a
     * rate limit, an unreachable network. Each of those has something the
     * user can do about it, and all of them were being reported as the one
     * situation where there is nothing to do.
     */
    const hasNoPullRequest =
      error instanceof GhError && NO_PULL_REQUEST.test(error.stderr);

    return {
      ...empty,
      blockers: [
        hasNoPullRequest
          ? mergeBlocker("no-pull-request")
          : githubUnavailableBlocker(
              error instanceof Error ? error.message : GH_UNKNOWN_FAILURE,
            ),
      ],
    };
  }

  const rollup = Array.isArray(view.statusCheckRollup)
    ? view.statusCheckRollup
    : [];

  const checkRuns: CheckRun[] = rollup.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const status = String(record.status ?? record.state ?? "").toUpperCase();
    const conclusion =
      typeof record.conclusion === "string" ? record.conclusion : null;

    return {
      id: typeof record.databaseId === "number" ? record.databaseId : null,
      name: String(record.name ?? record.context ?? "check"),
      status,
      conclusion,
      state: toCheckState(conclusion, status),
      detailsUrl:
        typeof record.detailsUrl === "string"
          ? record.detailsUrl
          : typeof record.targetUrl === "string"
            ? record.targetUrl
            : null,
    };
  });

  const checks = checkRuns.reduce<MergeReadinessChecks>(
    (acc, run) => {
      acc.total += 1;
      acc[run.state] += 1;
      return acc;
    },
    { ...EMPTY_CHECKS },
  );

  const blockers: MergeBlocker[] = [];
  if (String(view.state ?? "").toUpperCase() !== "OPEN") {
    blockers.push(mergeBlocker("not-open"));
  }
  if (view.isDraft === true) {
    blockers.push(mergeBlocker("draft"));
  }
  if (String(view.mergeable ?? "").toUpperCase() === "CONFLICTING") {
    blockers.push(mergeBlocker("conflicts"));
  }
  if (checks.failed > 0) {
    blockers.push(checksFailingBlocker(checks.failed));
  }
  if (checks.pending > 0) {
    blockers.push(checksRunningBlocker(checks.pending));
  }

  const number = Number(view.number);

  return {
    canMerge: blockers.length === 0,
    blockers,
    pr: Number.isInteger(number)
      ? {
          number,
          repo: `${sessionRecord.repoOwner ?? ""}/${sessionRecord.repoName}`,
          title: typeof view.title === "string" ? view.title : null,
          body: typeof view.body === "string" ? view.body : null,
          baseBranch:
            typeof view.baseRefName === "string" ? view.baseRefName : null,
          headBranch:
            typeof view.headRefName === "string" ? view.headRefName : null,
          headSha: typeof view.headRefOid === "string" ? view.headRefOid : null,
          additions: Number(view.additions) || 0,
          deletions: Number(view.deletions) || 0,
          changedFiles: Number(view.changedFiles) || 0,
          commits: Array.isArray(view.commits) ? view.commits.length : 0,
        }
      : null,
    allowedMethods: ALL_METHODS,
    defaultMethod: "squash",
    checks,
    checkRuns,
  };
}
