"use client";

import useSWR from "swr";
import type { PendingApprovalsResponse } from "@/app/api/sessions/[sessionId]/chats/[chatId]/approvals/route";
import { fetcher } from "@/lib/swr";

/**
 * Tool calls this chat's agent is blocked on.
 *
 * Polled rather than streamed. The approval is raised by a hook process
 * outside the workflow, so it never enters the chat's message stream — and
 * the agent is stopped dead until it is answered, so a two-second poll is the
 * difference between the user noticing and not.
 *
 * Polled for as long as the chat is open, not only while a turn looks active.
 * "Active" is the client's view of the stream, and a turn blocked on an
 * approval does not look active from there — the first attempt gated on it and
 * the card never appeared, while the agent sat waiting. The request is an
 * in-memory lookup, so polling it unconditionally costs far less than missing
 * the one moment it matters.
 */
export function usePendingApprovals({
  sessionId,
  chatId,
}: {
  sessionId: string;
  chatId: string;
}) {
  const { data, mutate } = useSWR<PendingApprovalsResponse>(
    `/api/sessions/${sessionId}/chats/${chatId}/approvals`,
    fetcher,
    { refreshInterval: 2000, revalidateOnFocus: true },
  );

  const decide = async (id: string, outcome: "allow" | "deny") => {
    // Removed locally first: the agent resumes the moment the server answers,
    // and leaving a dead card on screen for a poll interval reads as a
    // click that did not register.
    await mutate(
      (current) => ({
        approvals: (current?.approvals ?? []).filter((a) => a.id !== id),
      }),
      { revalidate: false },
    );

    await fetch(`/api/sessions/${sessionId}/chats/${chatId}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, outcome }),
    });

    await mutate();
  };

  return { approvals: data?.approvals ?? [], decide };
}
