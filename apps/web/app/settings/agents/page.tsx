import type { Metadata } from "next";
import { AgentsPageContent } from "./agents-page-content";

export const metadata: Metadata = {
  title: "Agents",
  description: "The roster of subagents this organisation's chats delegate to.",
};

/**
 * Manage the organisation's roster: the subagents a chat's orchestrator can
 * delegate to, replacing the two hardcoded defaults every chat used to get.
 */
export default function AgentsPage() {
  return <AgentsPageContent />;
}
