"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

type OwnersResponse = { owners: string[]; error?: string };

/**
 * Accounts the user can create a repository under.
 *
 * Their own login first, then any organisations. Organisations need the
 * `read:org` scope; without it the list is just the user, which is still a
 * perfectly good answer and not worth an error.
 */
export function useGithubOwners({ enabled = true } = {}) {
  const { data, isLoading } = useSWR<OwnersResponse>(
    enabled ? "/api/github/owners" : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  return {
    owners: data?.owners ?? [],
    loading: isLoading,
    error: data?.error ?? null,
  };
}
