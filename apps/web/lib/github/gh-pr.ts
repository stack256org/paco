import "server-only";

import { gh, GhError, ghJson, git } from "./gh";

/**
 * Pull request operations, expressed as `gh` invocations.
 *
 * Scoped to a chat, not a session. Each chat works in its own git worktree on
 * `chat/<chatId>`, so that branch — not the session's — is what a pull request
 * has to be opened from, and what its checks belong to.
 */

type PullRequestState = "open" | "closed" | "merged";

export type PullRequestSummary = {
  number: number;
  url: string;
  state: PullRequestState;
  title: string;
  isDraft: boolean;
  /** Rolled-up CI conclusion, or `null` when the PR has no checks. */
  checks: "passing" | "failing" | "pending" | null;
  mergedAt: string | null;
  baseBranch: string;
  headBranch: string;
};

type PrView = {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  title?: unknown;
  isDraft?: unknown;
  mergedAt?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  statusCheckRollup?: unknown;
};

const PR_FIELDS =
  "number,url,state,title,isDraft,mergedAt,baseRefName,headRefName,statusCheckRollup";

const PUSH_TIMEOUT_MS = 180_000;

/**
 * Roll a PR's individual check runs up to one word.
 *
 * `statusCheckRollup` is a flat list of runs and statuses, each with its own
 * shape: check runs report `conclusion`, older commit statuses report `state`.
 * A single failure outweighs any number of passes, and anything still running
 * means the answer is not yet known — so the order of these tests matters.
 */
function rollUpChecks(rollup: unknown): PullRequestSummary["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return null;
  }

  let sawPending = false;

  for (const entry of rollup) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const outcome = String(
      record.conclusion ?? record.state ?? record.status ?? "",
    ).toUpperCase();

    if (
      outcome === "FAILURE" ||
      outcome === "TIMED_OUT" ||
      outcome === "CANCELLED" ||
      outcome === "ERROR" ||
      outcome === "ACTION_REQUIRED"
    ) {
      return "failing";
    }

    if (
      outcome === "" ||
      outcome === "PENDING" ||
      outcome === "QUEUED" ||
      outcome === "IN_PROGRESS" ||
      outcome === "WAITING" ||
      outcome === "REQUESTED"
    ) {
      sawPending = true;
    }
  }

  return sawPending ? "pending" : "passing";
}

function toSummary(view: PrView): PullRequestSummary {
  const number = Number(view.number);
  if (!Number.isInteger(number)) {
    throw new GhError(
      "GitHub did not report a pull request number",
      "failed",
      0,
      "",
    );
  }

  const rawState = String(view.state ?? "").toUpperCase();
  const state: PullRequestState =
    rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : "open";

  return {
    number,
    url: String(view.url ?? ""),
    state,
    title: String(view.title ?? ""),
    isDraft: view.isDraft === true,
    checks: rollUpChecks(view.statusCheckRollup),
    mergedAt: typeof view.mergedAt === "string" ? view.mergedAt : null,
    baseBranch: String(view.baseRefName ?? ""),
    headBranch: String(view.headRefName ?? ""),
  };
}

/**
 * Push a chat's branch to `origin`.
 *
 * `gh pr create` will not open a pull request for a branch the remote has never
 * heard of, and its own offer to push is interactive — which is disabled here,
 * so it would simply fail. Pushing explicitly first also means a rejected push
 * is reported as a push failure rather than as a confusing PR error.
 */
async function pushBranch(params: {
  token: string;
  cwd: string;
  branch: string;
}): Promise<void> {
  await git(["push", "--set-upstream", "origin", params.branch], {
    token: params.token,
    cwd: params.cwd,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
}

/**
 * Open a pull request from a chat's branch.
 *
 * The title and body go straight through as arguments. Because nothing here
 * reaches a shell, a body containing backticks or `$(…)` — which a generated
 * PR description very plausibly does — is inert data.
 *
 * Returns the full summary rather than just a URL, so the caller does not have
 * to immediately ask again for the number and state it needs to store.
 */
export async function createPullRequest(params: {
  token: string;
  cwd: string;
  base: string;
  head: string;
  title: string;
  body?: string;
  draft?: boolean;
}): Promise<PullRequestSummary> {
  await pushBranch({
    token: params.token,
    cwd: params.cwd,
    branch: params.head,
  });

  const args = [
    "pr",
    "create",
    "--base",
    params.base,
    "--head",
    params.head,
    "--title",
    params.title,
    "--body",
    params.body ?? "",
  ];

  if (params.draft) {
    args.push("--draft");
  }

  await gh(args, { token: params.token, cwd: params.cwd });

  return viewPullRequestForBranch({
    token: params.token,
    cwd: params.cwd,
    branch: params.head,
  });
}

/** The pull request for a branch, or `null` when there is none. */
async function viewPullRequestForBranch(params: {
  token: string;
  cwd: string;
  branch: string;
}): Promise<PullRequestSummary> {
  const view = await ghJson<PrView>(
    ["pr", "view", params.branch, "--json", PR_FIELDS],
    { token: params.token, cwd: params.cwd },
  );

  return toSummary(view);
}

/**
 * A branch's pull request, or `null` if it has none.
 *
 * `gh pr view` exits non-zero when no pull request exists, which is an ordinary
 * answer here rather than a failure — so it is translated instead of thrown.
 * Any other failure is still raised.
 */
export async function findPullRequest(params: {
  token: string;
  cwd: string;
  branch: string;
}): Promise<PullRequestSummary | null> {
  try {
    return await viewPullRequestForBranch(params);
  } catch (error) {
    if (
      error instanceof GhError &&
      /no pull requests found/i.test(error.stderr)
    ) {
      return null;
    }
    if (
      error instanceof GhError &&
      /no pull requests found/i.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

/** Merge a pull request. */
export async function mergePullRequest(params: {
  token: string;
  cwd: string;
  number: number;
  method: "merge" | "squash" | "rebase";
  deleteBranch?: boolean;
}): Promise<PullRequestSummary> {
  const args = ["pr", "merge", String(params.number), `--${params.method}`];

  if (params.deleteBranch) {
    args.push("--delete-branch");
  }

  await gh(args, { token: params.token, cwd: params.cwd });

  const view = await ghJson<PrView>(
    ["pr", "view", String(params.number), "--json", PR_FIELDS],
    { token: params.token, cwd: params.cwd },
  );

  return toSummary(view);
}

/** Close a pull request without merging it. */
export async function closePullRequest(params: {
  token: string;
  cwd: string;
  number: number;
}): Promise<PullRequestSummary> {
  await gh(["pr", "close", String(params.number)], {
    token: params.token,
    cwd: params.cwd,
  });

  const view = await ghJson<PrView>(
    ["pr", "view", String(params.number), "--json", PR_FIELDS],
    { token: params.token, cwd: params.cwd },
  );

  return toSummary(view);
}
