import type { SessionWithUnread } from "@/hooks/use-sessions";

/**
 * One reading of the workspace list.
 *
 * The same shape arrives from three places — the `/api/sessions` route, the
 * SWR cache, and the server-rendered prop the sessions layout hands down — so
 * reconciling them is a question about two values of this type rather than
 * about React.
 *
 * `archivedCount` is optional because `/api/sessions` with no `status` filter
 * does not report one; only the `active` and `archived` filters do.
 */
export interface SessionsSnapshot {
  sessions: SessionWithUnread[];
  archivedCount?: number;
}

/**
 * Dates survive a React Server Component payload as `Date` and a JSON response
 * as a string, and both end up typed as `Date`. Comparing them has to cope
 * with either without trusting the type.
 */
function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function isSameSession(a: SessionWithUnread, b: SessionWithUnread): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.status === b.status &&
    a.repoOwner === b.repoOwner &&
    a.repoName === b.repoName &&
    a.branch === b.branch &&
    a.linesAdded === b.linesAdded &&
    a.linesRemoved === b.linesRemoved &&
    a.prNumber === b.prNumber &&
    a.prStatus === b.prStatus &&
    a.prChecks === b.prChecks &&
    a.hasUnread === b.hasUnread &&
    a.hasStreaming === b.hasStreaming &&
    a.latestChatId === b.latestChatId &&
    toTimestamp(a.createdAt) === toTimestamp(b.createdAt) &&
    toTimestamp(a.lastActivityAt) === toTimestamp(b.lastActivityAt)
  );
}

/**
 * Whether two snapshots say the same thing.
 *
 * Used to tell a genuinely new server render from the same one arriving again:
 * a React Server Component payload is a fresh object every time it is
 * delivered, so identity says nothing. Applying the same snapshot twice is not
 * harmless — the second write would overwrite whatever the poll fetched in
 * between with a reading from page load.
 */
export function sessionsSnapshotsEqual(
  a: SessionsSnapshot | undefined,
  b: SessionsSnapshot | undefined,
): boolean {
  if (a === b) {
    return true;
  }

  if (!(a && b)) {
    return false;
  }

  if (a.archivedCount !== b.archivedCount) {
    return false;
  }

  if (a.sessions.length !== b.sessions.length) {
    return false;
  }

  return a.sessions.every((session, index) => {
    const other = b.sessions[index];
    return other !== undefined && isSameSession(session, other);
  });
}

/**
 * What to show once a fresh server render arrives with a warm client cache.
 *
 * The server read the database moments ago, so it wins by default — the cache
 * can be half a minute old, or worse, be the answer to a different question
 * (the home page asks `/api/sessions` for every status under the same cache
 * key the sessions layout uses for the active ones).
 *
 * The exception is a workspace with a request still in flight. Archiving,
 * restoring and renaming all paint the result before the PATCH returns, and
 * the server snapshot was rendered before that PATCH landed — taking it
 * wholesale would resurrect the row the user just archived, for as long as it
 * takes the request to finish. Those ids keep their optimistic value, and a
 * pending id the cache no longer lists (an optimistic removal) stays removed.
 *
 * `archivedCount` follows the same rule in aggregate: while anything is
 * pending, the count the optimistic updates have been maintaining is the one
 * that matches the visible rows.
 */
export function reconcileServerSessions({
  server,
  cached,
  pendingSessionIds,
}: {
  server: SessionsSnapshot;
  cached: SessionsSnapshot | undefined;
  pendingSessionIds: ReadonlySet<string>;
}): SessionsSnapshot {
  if (!cached || pendingSessionIds.size === 0) {
    return server;
  }

  const cachedById = new Map(
    cached.sessions.map((session) => [session.id, session] as const),
  );
  const serverIds = new Set(server.sessions.map((session) => session.id));

  const sessions: SessionWithUnread[] = [];

  // A pending row the server has not heard of yet — a workspace being created
  // or restored — goes at the head, which is where the server puts a freshly
  // active workspace once it knows about it.
  for (const session of cached.sessions) {
    if (pendingSessionIds.has(session.id) && !serverIds.has(session.id)) {
      sessions.push(session);
    }
  }

  for (const session of server.sessions) {
    if (!pendingSessionIds.has(session.id)) {
      sessions.push(session);
      continue;
    }

    const optimistic = cachedById.get(session.id);
    if (optimistic) {
      sessions.push(optimistic);
    }
  }

  return {
    sessions,
    archivedCount: cached.archivedCount ?? server.archivedCount,
  };
}
