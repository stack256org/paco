"use client";

import useSWR from "swr";
import { getGitStatus, type SessionGitStatus } from "@/lib/git/queries/status";

export type { SessionGitStatus } from "@/lib/git/queries/status";

export interface UseSessionGitStatusReturn {
  gitStatus: SessionGitStatus | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<SessionGitStatus | undefined>;
}

async function fetchGitStatus(
  sessionId: string,
  chatId: string,
): Promise<SessionGitStatus> {
  const result = await getGitStatus({ sessionId, chatId });
  if (!result) {
    throw new Error("Failed to fetch git status");
  }
  return result;
}

/**
 * Status of the chat's worktree.
 *
 * Chat-scoped, because that is where the work is. Pointed at the session's
 * repository it reported a clean tree on the default branch — technically
 * true, and never what the user had just changed.
 */
export function useSessionGitStatus(
  sessionId: string,
  sandboxConnected: boolean,
  chatId: string,
): UseSessionGitStatusReturn {
  const key = sandboxConnected
    ? (["git-status", sessionId, chatId] as const)
    : null;

  const { data, error, isLoading, mutate } = useSWR<SessionGitStatus>(
    key,
    async ([, id, chat]: readonly [string, string, string]) =>
      fetchGitStatus(id, chat),
    {
      revalidateOnFocus: false,
      dedupingInterval: 1500,
    },
  );

  return {
    gitStatus: data ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: mutate,
  };
}
