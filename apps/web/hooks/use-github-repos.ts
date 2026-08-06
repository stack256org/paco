"use client";

import useSWR from "swr";
import type { GithubRepoSummary } from "@/app/api/github/repos/route";
import { fetcher } from "@/lib/swr";

type ReposResponse = {
  repos: GithubRepoSummary[];
  error?: string;
};

/**
 * Repositories the connected account can reach.
 *
 * Replaces the pair of App hooks this used to need — one to list installations,
 * another to list the repositories inside a chosen installation. A token has no
 * installations, so the repository list is simply the repository list, and the
 * UI no longer has to explain the concept before it can show anything.
 */
export function useGithubRepos({
  enabled = true,
  query,
}: {
  enabled?: boolean;
  query?: string;
} = {}) {
  const key = enabled
    ? `/api/github/repos${query ? `?q=${encodeURIComponent(query)}` : ""}`
    : null;

  const { data, error, isLoading } = useSWR<ReposResponse>(key, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  return {
    repos: data?.repos ?? [],
    loading: isLoading,
    error: data?.error ?? (error as Error | undefined)?.message ?? null,
  };
}
