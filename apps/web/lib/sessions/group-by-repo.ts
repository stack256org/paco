import type { SessionWithUnread } from "@/hooks/use-sessions";

/**
 * Grouping sessions by the repository they came from.
 *
 * Lifted out of the old sidebar so the workspace switcher can group the same
 * way the sidebar did. There is no workspace row in the database — a workspace
 * *is* a session, and these groups are derived from `repoOwner`/`repoName`.
 */

export type SessionRepoGroup = {
  id: string;
  label: string;
  sessions: SessionWithUnread[];
};

const UNSCOPED_GROUP_ID = "repo:unscoped";

export function getRepoGroupId(session: SessionWithUnread): string {
  const repoName = session.repoName?.trim();
  const repoOwner = session.repoOwner?.trim();

  if (!repoName) {
    return UNSCOPED_GROUP_ID;
  }

  return `repo:${repoOwner ?? ""}/${repoName}`.toLowerCase();
}

/**
 * Sessions that came from a repository group under `owner/repo`; the rest need
 * a heading of their own. "Chats" would name the wrong thing entirely — a chat
 * is a conversation *inside* a session, and those are the tabs across the top.
 */
export function getRepoGroupLabel(session: SessionWithUnread): string {
  const repoName = session.repoName?.trim();
  const repoOwner = session.repoOwner?.trim();

  if (!repoName) {
    return "No repository";
  }

  return repoOwner ? `${repoOwner}/${repoName}` : repoName;
}

export function groupSessionsByRepo(
  sessions: SessionWithUnread[],
): SessionRepoGroup[] {
  const groups = new Map<string, SessionRepoGroup>();

  for (const session of sessions) {
    const groupId = getRepoGroupId(session);
    const existingGroup = groups.get(groupId);

    if (existingGroup) {
      existingGroup.sessions.push(session);
      continue;
    }

    groups.set(groupId, {
      id: groupId,
      label: getRepoGroupLabel(session),
      sessions: [session],
    });
  }

  const result = Array.from(groups.values());

  // Repository-less sessions first: they have no other home, and burying them
  // under whichever repo happened to be seen first hides them.
  const unscopedIndex = result.findIndex((g) => g.id === UNSCOPED_GROUP_ID);
  if (unscopedIndex > 0) {
    const [unscoped] = result.splice(unscopedIndex, 1);
    result.unshift(unscoped);
  }

  return result;
}
