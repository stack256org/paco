"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "@/lib/toast";
import useSWR, { useSWRConfig } from "swr";
import {
  ACTIVE_SESSIONS_KEY,
  ALL_SESSIONS_KEY,
} from "@/lib/sessions/session-cache-keys";
import {
  reconcileServerSessions,
  type SessionsSnapshot,
  sessionsSnapshotsEqual,
} from "@/hooks/sessions-snapshot";
import type { Chat, Session } from "@/lib/db/schema";
import { fetcher } from "@/lib/swr";

export type SessionWithUnread = Pick<
  Session,
  | "id"
  | "title"
  | "status"
  | "repoOwner"
  | "repoName"
  | "branch"
  | "linesAdded"
  | "linesRemoved"
  | "prNumber"
  | "prStatus"
  | "prChecks"
  | "createdAt"
> & {
  hasUnread: boolean;
  hasStreaming: boolean;
  latestChatId: string | null;
  lastActivityAt: Session["createdAt"];
};

interface CreateSessionInput {
  title?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  cloneUrl?: string;
  isNewBranch: boolean;
  autoCommitPush: boolean;
  autoCreatePr: boolean;
}

interface CreateSessionResponse {
  session: Session;
  chat: Chat;
}

function cloneSessionsResponse(
  current: SessionsSnapshot | undefined,
): SessionsSnapshot | undefined {
  if (!current) {
    return undefined;
  }

  return {
    sessions: current.sessions.map((session) => ({ ...session })),
    archivedCount: current.archivedCount,
  };
}

function mergeSessionWithSummary(
  session: SessionWithUnread,
  updatedSession: Session,
): SessionWithUnread {
  return {
    id: updatedSession.id,
    title: updatedSession.title,
    status: updatedSession.status,
    repoOwner: updatedSession.repoOwner,
    repoName: updatedSession.repoName,
    branch: updatedSession.branch,
    linesAdded: updatedSession.linesAdded,
    linesRemoved: updatedSession.linesRemoved,
    prNumber: updatedSession.prNumber,
    prStatus: updatedSession.prStatus,
    prChecks: updatedSession.prChecks,
    createdAt: updatedSession.createdAt,
    hasUnread: session.hasUnread,
    hasStreaming: session.hasStreaming,
    latestChatId: session.latestChatId,
    lastActivityAt: session.lastActivityAt,
  };
}

export function useSessions(options?: {
  enabled?: boolean;
  includeArchived?: boolean;
  initialData?: SessionsSnapshot;
}) {
  const enabled = options?.enabled ?? true;
  const includeArchived = options?.includeArchived ?? true;
  // The key *is* the endpoint, so two different requests cannot land in one
  // cache entry. See `session-cache-keys.ts` for what that used to cost.
  const sessionsEndpoint = includeArchived
    ? ALL_SESSIONS_KEY
    : ACTIVE_SESSIONS_KEY;

  const initialData = options?.initialData;

  const { data, error, isLoading, mutate } = useSWR<SessionsSnapshot>(
    enabled ? sessionsEndpoint : null,
    () => fetcher<SessionsSnapshot>(sessionsEndpoint),
    {
      fallbackData: initialData,
      revalidateOnMount: initialData ? false : undefined,
      refreshInterval: (latestData) => {
        const hasStreamingSession = latestData?.sessions.some(
          (s) => s.hasStreaming,
        );
        // Poll quickly while any session is streaming so we detect
        // completion promptly for background-chat notifications.
        // Otherwise poll every 30s to pick up external changes like
        // PR merges delivered via GitHub webhooks.
        return hasStreamingSession ? 3_000 : 30_000;
      },
    },
  );
  const { mutate: globalMutate } = useSWRConfig();

  /**
   * Workspaces with a PATCH still in flight.
   *
   * Every mutation below paints its result before the request returns, so for
   * the length of that request the cache knows something the server render
   * does not. This is what stops a server snapshot rendered a moment earlier
   * from undoing it.
   */
  const pendingSessionIdsRef = useRef<Set<string>>(new Set());

  /** The last server snapshot written into the cache, to spot a new one. */
  const syncedServerDataRef = useRef<SessionsSnapshot | undefined>(undefined);

  /*
   * A fresh server render outranks the cache.
   *
   * This used to be `current ?? initialData`, which seeded an empty cache and
   * then never spoke again: whatever the client held won for good, so a
   * navigation or a `router.refresh()` that re-read the database changed
   * nothing on screen. Restoring a workspace was where it showed — the active
   * list and the `Archived N` badge stayed as they were — but archive, create
   * and rename all sat behind the same rule.
   *
   * Skipping when the snapshot is unchanged is the part of the old guard worth
   * keeping. A server payload is a new object on every delivery, so without it
   * an unrelated re-render would write a page-load reading over whatever the
   * 30s poll had just fetched. The optimistic half of the guard now lives in
   * `reconcileServerSessions`, which is narrower: it protects the workspaces
   * actually mid-request instead of the whole list.
   */
  useEffect(() => {
    if (!enabled || !initialData) {
      return;
    }

    if (sessionsSnapshotsEqual(syncedServerDataRef.current, initialData)) {
      return;
    }

    syncedServerDataRef.current = initialData;

    void mutate(
      (current) =>
        reconcileServerSessions({
          server: initialData,
          cached: current,
          pendingSessionIds: pendingSessionIdsRef.current,
        }),
      { revalidate: false },
    );
  }, [enabled, initialData, mutate]);

  const sessions = data?.sessions ?? [];
  const archivedCount = data?.archivedCount ?? 0;

  const createSession = useCallback(
    async (input: CreateSessionInput) => {
      const previousData = cloneSessionsResponse(data);

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      const responseData = (await res.json()) as {
        session?: Session;
        chat?: Chat;
        error?: string;
      };

      if (!res.ok || !responseData.session || !responseData.chat) {
        const message = responseData.error ?? "Failed to create session";
        toast.error(message);
        throw new Error(message);
      }

      const createdSession = responseData.session;
      const createdChat = responseData.chat;

      void globalMutate(
        `/api/sessions/${createdSession.id}/chats`,
        {
          chats: [
            {
              ...createdChat,
              hasUnread: false,
              isStreaming: false,
            },
          ],
          defaultModelId: createdChat.modelId,
        },
        { revalidate: false },
      );

      await mutate(
        (current) => {
          const source = current ?? previousData;

          return {
            sessions: [
              {
                ...createdSession,
                hasUnread: false,
                hasStreaming: false,
                latestChatId: createdChat.id,
                lastActivityAt: createdChat.updatedAt,
              },
              ...(source?.sessions ?? []),
            ],
            archivedCount: source?.archivedCount,
          };
        },
        { revalidate: false },
      );

      return {
        session: createdSession,
        chat: createdChat,
      } satisfies CreateSessionResponse;
    },
    [data, globalMutate, mutate],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const previousData = cloneSessionsResponse(data);

      await mutate(
        (current) => {
          const source = current ?? previousData;
          if (!source) {
            return source;
          }

          return {
            ...source,
            sessions: source.sessions.map((session) =>
              session.id === sessionId ? { ...session, title } : session,
            ),
          };
        },
        { revalidate: false },
      );

      // Marked only once the optimistic write has landed, so the `finally`
      // that clears it is always reachable.
      pendingSessionIdsRef.current.add(sessionId);

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });

        const responseData = (await res.json()) as {
          session?: Session;
          error?: string;
        };

        if (!res.ok || !responseData.session) {
          throw new Error(responseData.error ?? "Failed to rename session");
        }

        const updatedSession = responseData.session;

        await mutate(
          (current) => {
            if (!current) {
              return current;
            }

            return {
              ...current,
              sessions: current.sessions.map((session) =>
                session.id === sessionId
                  ? mergeSessionWithSummary(session, updatedSession)
                  : session,
              ),
            };
          },
          { revalidate: false },
        );

        return updatedSession;
      } catch (error) {
        if (previousData) {
          await mutate(previousData, { revalidate: false });
        } else {
          void mutate();
        }

        throw error;
      } finally {
        pendingSessionIdsRef.current.delete(sessionId);
      }
    },
    [data, mutate],
  );

  const archiveSession = useCallback(
    async (sessionId: string) => {
      const previousData = cloneSessionsResponse(data);
      const sessionToArchive = previousData?.sessions.find(
        (session) => session.id === sessionId,
      );
      const hadSession = Boolean(sessionToArchive);
      const wasArchived = sessionToArchive?.status === "archived";

      await mutate(
        (current) => {
          const source = current ?? previousData;
          if (!source) {
            return source;
          }

          const nextArchivedCount =
            hadSession && !wasArchived
              ? (source.archivedCount ?? 0) + 1
              : source.archivedCount;

          if (!includeArchived) {
            return {
              ...source,
              sessions: source.sessions.filter(
                (session) => session.id !== sessionId,
              ),
              archivedCount: nextArchivedCount,
            };
          }

          return {
            ...source,
            archivedCount: nextArchivedCount,
            sessions: source.sessions.map((session) =>
              session.id === sessionId
                ? { ...session, status: "archived" }
                : session,
            ),
          };
        },
        { revalidate: false },
      );

      // Marked only once the optimistic write has landed, so the `finally`
      // that clears it is always reachable.
      pendingSessionIdsRef.current.add(sessionId);

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "archived" }),
        });

        const responseData = (await res.json()) as {
          session?: Session;
          error?: string;
        };

        if (!res.ok) {
          throw new Error(responseData.error ?? "Failed to archive session");
        }

        if (responseData.session) {
          const updatedSession = responseData.session;

          await mutate(
            (current) => {
              if (!current) {
                return current;
              }

              if (!includeArchived) {
                return current;
              }

              return {
                ...current,
                sessions: current.sessions.map((session) =>
                  session.id === sessionId
                    ? mergeSessionWithSummary(session, updatedSession)
                    : session,
                ),
              };
            },
            { revalidate: false },
          );
        }

        return responseData.session;
      } catch (error) {
        if (previousData) {
          await mutate(previousData, { revalidate: false });
        } else {
          void mutate();
        }

        throw error;
      } finally {
        pendingSessionIdsRef.current.delete(sessionId);
      }
    },
    [data, includeArchived, mutate],
  );

  const unarchiveSession = useCallback(
    async (sessionId: string) => {
      const previousData = cloneSessionsResponse(data);
      const nextArchivedCount = Math.max(
        (previousData?.archivedCount ?? 0) - 1,
        0,
      );

      await mutate(
        (current) => {
          const source = current ?? previousData;
          if (!source) {
            return source;
          }

          return {
            ...source,
            archivedCount: nextArchivedCount,
            sessions: includeArchived
              ? source.sessions.map((session) =>
                  session.id === sessionId
                    ? { ...session, status: "running" }
                    : session,
                )
              : source.sessions,
          };
        },
        { revalidate: false },
      );

      // Marked only once the optimistic write has landed, so the `finally`
      // that clears it is always reachable.
      pendingSessionIdsRef.current.add(sessionId);

      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "running" }),
        });

        const responseData = (await res.json()) as {
          session?: Session;
          error?: string;
        };

        if (!res.ok || !responseData.session) {
          throw new Error(responseData.error ?? "Failed to unarchive session");
        }

        const updatedSession = responseData.session;

        if (includeArchived) {
          await mutate(
            (current) => {
              if (!current) {
                return current;
              }

              return {
                ...current,
                sessions: current.sessions.map((session) =>
                  session.id === sessionId
                    ? mergeSessionWithSummary(session, updatedSession)
                    : session,
                ),
              };
            },
            { revalidate: false },
          );
        } else {
          await mutate();
        }

        return responseData.session;
      } catch (error) {
        if (previousData) {
          await mutate(previousData, { revalidate: false });
        } else {
          void mutate();
        }

        throw error;
      } finally {
        pendingSessionIdsRef.current.delete(sessionId);
      }
    },
    [data, includeArchived, mutate],
  );

  return {
    sessions,
    archivedCount,
    loading: isLoading,
    error,
    createSession,
    renameSession,
    archiveSession,
    unarchiveSession,
    refreshSessions: mutate,
  };
}
