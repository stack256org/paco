"use client";

import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  ACTIVE_SESSIONS_KEY,
  ARCHIVED_SESSIONS_KEY,
} from "@/lib/sessions/session-cache-keys";
import type { SessionWithUnread } from "@/hooks/use-sessions";
import type { Session } from "@/lib/db/schema";
import { fetcher } from "@/lib/swr";

/**
 * The archived half of the workspace list, and the one action that undoes
 * archiving.
 *
 * Separate from `useSessions` on purpose. That hook backs the switcher's live
 * list and polls every few seconds so a streaming workspace updates; archived
 * workspaces never change on their own, and there can be a hundred of them, so
 * they are fetched once and only when someone actually opens the section.
 *
 * Restoring is a `status: "running"` PATCH and nothing else — no container is
 * started here. The workspace directory is still on disk and the sandbox keeps
 * its name through archiving, so the first thing that needs a container (the
 * reconnect probe on the chat page, or "Start preview") wakes one lazily. Doing
 * it eagerly would mean every restore paid for a Docker start the user may not
 * have wanted.
 */

// Imported rather than re-declared: a second copy of a cache key is a cache
// entry nobody updates the day the first one changes.

interface ArchivedSessionsResponse {
  sessions: SessionWithUnread[];
  archivedCount: number;
  pagination?: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number;
  };
}

export function useArchivedSessions(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { mutate: globalMutate } = useSWRConfig();

  const { data, error, isLoading, mutate } = useSWR<ArchivedSessionsResponse>(
    enabled ? ARCHIVED_SESSIONS_KEY : null,
    () => fetcher<ArchivedSessionsResponse>(ARCHIVED_SESSIONS_KEY),
    {
      revalidateOnFocus: false,
    },
  );

  const restoreSession = useCallback(
    async (sessionId: string): Promise<Session> => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      });

      const responseData = (await res.json()) as {
        session?: Session;
        error?: string;
      };

      // No optimistic removal: the API refuses to restore a workspace whose
      // container is still shutting down, and a row that vanished and came back
      // would read as a bug rather than as "not yet".
      if (!res.ok || !responseData.session) {
        throw new Error(responseData.error ?? "Failed to restore workspace");
      }

      await mutate(
        (current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.filter(
                  (session) => session.id !== sessionId,
                ),
                archivedCount: Math.max(current.archivedCount - 1, 0),
              }
            : current,
        { revalidate: false },
      );

      /*
       * The restored workspace belongs in the live list now.
       *
       * Both halves are needed. A bare revalidation was not enough in practice:
       * `useSessions` seeds itself from a server prop and keeps whichever data
       * it already has, so the switcher went on showing the old count until the
       * next full page load. The updater fixes the count that this call is
       * certain about; the revalidation fetches the row itself, which only the
       * server can place in the right repository group.
       */
      await globalMutate<{
        sessions: SessionWithUnread[];
        archivedCount?: number;
      }>(
        ACTIVE_SESSIONS_KEY,
        (current) =>
          current
            ? {
                ...current,
                archivedCount: Math.max((current.archivedCount ?? 1) - 1, 0),
              }
            : current,
        { revalidate: true },
      );

      return responseData.session;
    },
    [globalMutate, mutate],
  );

  return {
    archivedSessions: data?.sessions ?? [],
    archivedCount: data?.archivedCount ?? 0,
    loading: isLoading,
    error,
    restoreSession,
  };
}
