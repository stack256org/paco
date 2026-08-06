"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { FilesResponse } from "@/app/api/sessions/[sessionId]/files/route";

export interface UseSessionFilesReturn {
  files: FilesResponse["files"] | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<FilesResponse | undefined>;
}

/**
 * Files in the chat's worktree.
 *
 * Chat-scoped: the session's repository sits on the default branch and holds
 * none of the chat's work, so listing it showed an empty tree.
 */
export function useSessionFiles(
  sessionId: string,
  sandboxConnected: boolean,
  chatId: string,
): UseSessionFilesReturn {
  const { data, error, isLoading, mutate } = useSWR<FilesResponse>(
    sandboxConnected
      ? `/api/sessions/${sessionId}/files?chatId=${encodeURIComponent(chatId)}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
    },
  );

  return {
    files: data?.files ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: mutate,
  };
}
