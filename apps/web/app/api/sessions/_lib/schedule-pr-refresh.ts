import "server-only";

import { after } from "next/server";
import {
  getSessionsWithOpenPullRequests,
  updatePullRequestState,
} from "@/lib/db/sessions";
import { refreshPullRequests } from "@/lib/github/pr-refresh";

/**
 * Refresh cached pull-request state after the response has gone out.
 *
 * The GitHub App used a webhook for this, which GitHub cannot deliver to a
 * self-hosted install on localhost — so a merged pull request stayed "open" in
 * Paco indefinitely. The state is polled instead, and `after()` is what keeps
 * that from costing the user anything: the list they asked for is returned
 * immediately from the database, and GitHub is consulted afterwards, so the
 * sidebar is at most one poll behind rather than slower on every request.
 *
 * Failures are swallowed on purpose. This is a cache refresh; if it does not
 * work, the previous values remain and the next poll tries again. Nothing the
 * user asked for has failed.
 */
export function schedulePullRequestRefresh(): void {
  after(async () => {
    try {
      const candidates = await getSessionsWithOpenPullRequests();
      if (candidates.length === 0) {
        return;
      }

      const refreshed = await refreshPullRequests({
        sessions: candidates,
      });

      for (const update of refreshed) {
        await updatePullRequestState(update);
      }
    } catch (error) {
      console.error("[github] Pull request refresh failed:", error);
    }
  });
}
