"use client";

import useSWR from "swr";
import type { SessionWithUnread } from "@/hooks/use-sessions";
import type { Session } from "@/lib/db/schema";
import { ACTIVE_SESSIONS_KEY } from "@/lib/sessions/session-cache-keys";

type SessionsResponse = {
  sessions: SessionWithUnread[];
};

/**
 * The session row as it is *now*, not as it was when the page was rendered.
 *
 * The header used to read the server-rendered session and never look again.
 * A session starts life named after a random city and is renamed from the
 * first message a moment later, so the header sat on "Ottawa" while the
 * sidebar — which polls — showed "Animated To-do List App". Same session,
 * two names on screen at once. Line counts and PR status drifted the same way.
 *
 * This reads the sidebar's SWR cache rather than fetching: same key, no
 * fetcher, no refresh interval. It costs no extra request and re-renders when
 * the sidebar's poll lands. When the session isn't in that list — an archived
 * session, or before the first poll resolves — the server-rendered values
 * stand in.
 */
export function useLiveSession(initialSession: Session): Session {
  const { data } = useSWR<SessionsResponse>(ACTIVE_SESSIONS_KEY, null, {
    revalidateOnMount: false,
    revalidateOnFocus: false,
    refreshInterval: 0,
  });

  const live = data?.sessions.find(
    (session) => session.id === initialSession.id,
  );

  if (!live) {
    return initialSession;
  }

  return {
    ...initialSession,
    title: live.title,
    status: live.status,
    repoOwner: live.repoOwner,
    repoName: live.repoName,
    branch: live.branch,
    linesAdded: live.linesAdded,
    linesRemoved: live.linesRemoved,
    prNumber: live.prNumber,
    prStatus: live.prStatus,
  };
}
