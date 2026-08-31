import "server-only";

import { getGithubConnection } from "@/lib/db/github-tokens";
import { DEFAULT_GIT_USER } from "@paco/sandbox";

/**
 * The git identity commits in a session are made under.
 *
 * Taken from the connected GitHub account so a commit the agent makes is
 * attributed to the user on GitHub rather than to a generic bot. The
 * `<id>+<login>@users.noreply.github.com` form is GitHub's own privacy
 * address: it links the commit to the account without publishing an email, and
 * unlike the shorter `<login>@…` variant it is accepted by repositories that
 * enforce email privacy.
 *
 * Falls back to Paco's own identity when no account is connected. Git refuses
 * to commit without one at all, and a session with no GitHub connection is
 * still a session that has to be able to commit locally.
 *
 * Unfiltered read: the instance has exactly one tenant, so its one
 * connection (if any) is the correct one to use.
 */
export type GitIdentity = { name: string; email: string };

export async function getGitIdentity(): Promise<GitIdentity> {
  const connection = await getGithubConnection();
  if (!connection) {
    return { ...DEFAULT_GIT_USER };
  }

  const email =
    connection.githubUserId === null
      ? // A token stored before the numeric id was recorded. The legacy form
        // still resolves for most repositories.
        `${connection.login}@users.noreply.github.com`
      : `${connection.githubUserId}+${connection.login}@users.noreply.github.com`;

  return { name: connection.login, email };
}
