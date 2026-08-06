"use client";

import { useParams } from "next/navigation";

/**
 * The chat this panel belongs to.
 *
 * Read from the route rather than threaded through props: commit and
 * pull-request actions are scoped to a chat's worktree and branch now, and
 * these panels sit several prop-drilling levels inside a route that already
 * knows the answer.
 */
export function useChatId(): string {
  const params = useParams<{ chatId?: string }>();
  return typeof params.chatId === "string" ? params.chatId : "";
}
