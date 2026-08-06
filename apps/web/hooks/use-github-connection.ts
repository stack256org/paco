"use client";

import useSWR from "swr";
import type { GithubConnectionResponse } from "@/app/api/github/connection/route";
import {
  githubConnectionState,
  type GithubConnectionState,
} from "@/lib/github/connection-state";
import { fetcher } from "@/lib/swr";

/**
 * Whether this user has connected GitHub, and what their token can do.
 *
 * Replaces the App-era connection status, which had three states — not
 * connected, connected, and "reconnect required" — plus a separate notion of
 * whether the App had been *installed* anywhere. A token either works or it
 * does not, so the only question left is whether one is stored.
 *
 * `state` is the answer to "what should we tell the user", and callers should
 * prefer it to assembling that from the booleans themselves. Two of the ways a
 * connection can be broken — a token Paco can no longer decrypt, and a missing
 * `gh` — are not absences of a connection, and code that inferred them from
 * `!connected` got both of them wrong.
 */
export function useGithubConnection({ enabled = true } = {}) {
  const { data, error, isLoading, mutate } = useSWR<GithubConnectionResponse>(
    enabled ? "/api/github/connection" : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  const state: GithubConnectionState = githubConnectionState(data);

  return {
    connected: data?.connected ?? false,
    login: data?.login ?? null,
    scopes: data?.scopes ?? [],
    missingScopes: data?.missingScopes ?? [],
    /** True when `gh` itself is absent, which no token can fix. */
    cliMissing: data?.cliMissing ?? false,
    /**
     * True when a token is stored but cannot be decrypted, because
     * `APP_SECRET` changed. `connected` is still true in this case — the login
     * beside the sealed token reads back fine — so anything that only asks
     * `connected` shows no warning at all and then fails on every action.
     */
    tokenUnreadable: data?.tokenUnreadable ?? false,
    /** The single value the UI should branch on. */
    state,
    loading: isLoading,
    error,
    refresh: mutate,
  };
}
