"use client";

import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";

type InvitationResponse = { email: string | null };

/**
 * The address `?invitation=<token>` in the URL was sent to, or `null`.
 *
 * Reads the query param itself rather than taking it as a prop so every
 * caller shares one source of truth for it. `null` covers three cases the
 * caller must not need to tell apart: there is no `invitation` param, the
 * token doesn't resolve to a live invitation, or the lookup hasn't returned
 * yet — in every case the sign-in form should behave exactly as it does for
 * someone who arrived with no token at all.
 */
export function useInvitationEmail(): string | null {
  const searchParams = useSearchParams();
  const token = searchParams.get("invitation");

  const { data } = useSWR<InvitationResponse>(
    token ? `/api/auth/invitation?token=${encodeURIComponent(token)}` : null,
    fetcher,
  );

  return data?.email ?? null;
}
