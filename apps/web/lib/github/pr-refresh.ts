import "server-only";

import { chatBranchName } from "@paco/sandbox";
import { hostChatWorktree } from "@/lib/agent/workspace-paths";
import { getGithubToken } from "@/lib/db/github-tokens";
import { getSoleUserId } from "@/lib/db/users";
import { findPullRequest } from "./gh-pr";

/**
 * Bring a session's cached pull-request state up to date.
 *
 * This replaces the webhook the GitHub App used to rely on. A webhook cannot be
 * delivered to a self-hosted install on localhost, so it never worked here in
 * the first place — a merged pull request stayed "open" in Paco until something
 * else happened to refresh it.
 *
 * Polling has an obvious cost, so it is bounded in three ways: only sessions
 * that actually have an open pull request are checked, no session is checked
 * more often than {@link MIN_REFRESH_INTERVAL_MS}, and the work runs after the
 * response rather than in front of it — the list a user sees is one poll behind
 * at worst, and never slower for it.
 */

/** Do not ask GitHub about the same pull request more often than this. */
export const MIN_REFRESH_INTERVAL_MS = 30_000;

type RefreshableSession = {
  id: string;
  prNumber: number | null;
  prStatus: "open" | "merged" | "closed" | null;
  prCheckedAt: Date | null;
  sandboxState: unknown;
  latestChatId: string | null;
};

export type PullRequestRefresh = {
  sessionId: string;
  prStatus: "open" | "merged" | "closed";
  prChecks: "passing" | "failing" | "pending" | null;
  prNumber: number;
};

/**
 * Whether this session is worth asking GitHub about.
 *
 * A merged or closed pull request is final, so it never needs checking again.
 * That is what keeps a long list of finished sessions from costing anything.
 */
export function shouldRefresh(
  session: RefreshableSession,
  now: number,
): boolean {
  if (!session.prNumber || session.prStatus !== "open") {
    return false;
  }
  if (!session.sandboxState || !session.latestChatId) {
    return false;
  }

  const checkedAt = session.prCheckedAt?.getTime() ?? 0;
  return now - checkedAt >= MIN_REFRESH_INTERVAL_MS;
}

/**
 * Ask GitHub about one session's pull request.
 *
 * Returns `null` when nothing could be learned — no token, no sandbox, the
 * branch has no pull request any more. A failure here is not worth surfacing:
 * the cached state stays as it was and the next poll tries again.
 */
async function refreshOne(
  session: RefreshableSession,
  token: string,
): Promise<PullRequestRefresh | null> {
  if (!session.latestChatId || !session.sandboxState) {
    return null;
  }

  try {
    const pullRequest = await findPullRequest({
      token,
      cwd: hostChatWorktree(
        session.sandboxState as Parameters<typeof hostChatWorktree>[0],
        session.latestChatId,
      ),
      branch: chatBranchName(session.latestChatId),
    });

    if (!pullRequest) {
      return null;
    }

    return {
      sessionId: session.id,
      prNumber: pullRequest.number,
      prStatus: pullRequest.state,
      prChecks: pullRequest.checks,
    };
  } catch {
    // A stopped sandbox, a deleted worktree, a network blip. The cached state
    // is still the best answer available.
    return null;
  }
}

/**
 * Refresh every session that is due, and report what changed.
 *
 * Sequential rather than concurrent: each call spawns a `gh` process, and a
 * user with twenty open pull requests should not fork twenty processes at once
 * on a machine that is also running a coding agent.
 */
export async function refreshPullRequests(params: {
  sessions: RefreshableSession[];
  now?: number;
}): Promise<PullRequestRefresh[]> {
  const now = params.now ?? Date.now();
  const due = params.sessions.filter((session) => shouldRefresh(session, now));

  if (due.length === 0) {
    return [];
  }

  const token = await getGithubToken(await getSoleUserId());
  if (!token) {
    return [];
  }

  const results: PullRequestRefresh[] = [];
  for (const session of due) {
    const refresh = await refreshOne(session, token);
    if (refresh) {
      results.push(refresh);
    }
  }

  return results;
}
