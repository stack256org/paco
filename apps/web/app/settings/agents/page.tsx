import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isAdmin } from "@/lib/admin/require-admin";
import { getServerSession } from "@/lib/session/get-server-session";
import { AgentsPageContent } from "./agents-page-content";

export const metadata: Metadata = {
  title: "Agents",
  description: "The roster of subagents this organisation's chats delegate to.",
};

/**
 * Manage the organisation's roster: the subagents a chat's orchestrator can
 * delegate to, replacing the two hardcoded defaults every chat used to get.
 *
 * Server-gated the same way `/settings/users` and `/settings/health` are —
 * `notFound()` rather than a redirect, so a non-admin learns nothing about
 * whether the page exists — even though every read and mutation underneath
 * is fetched client-side and re-checks admin itself (`requireAdmin` in
 * `./actions.ts`).
 */
export default async function AgentsPage() {
  const session = await getServerSession();

  if (!session?.user?.id || !(await isAdmin(session.user.id))) {
    notFound();
  }

  return <AgentsPageContent />;
}
