import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionsWithUnread } from "@/lib/db/sessions";
import { SessionsIndexShell } from "./sessions-index-shell";

export const metadata: Metadata = {
  title: "Sessions",
  description: "View and manage your sessions.",
};

/**
 * `/sessions` with nothing chosen.
 *
 * It opens the most recently active session rather than an empty page. Every
 * route meaning "go back to my work" points here — the Back link in Settings,
 * and the redirect after archiving — and all of them landed on "Nothing open",
 * which reads as though the sessions have gone. Opening the one you were last
 * in is what going back is supposed to mean.
 *
 * The empty state is then only shown when it is actually true.
 */
export default async function SessionsPage() {
  const sessions = await getSessionsWithUnread({
    status: "active",
  });

  // The query orders most-recently-active first.
  const mostRecent = sessions.at(0);
  if (mostRecent?.latestChatId) {
    redirect(`/sessions/${mostRecent.id}/chats/${mostRecent.latestChatId}`);
  }

  return <SessionsIndexShell />;
}
