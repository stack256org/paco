import type { Metadata } from "next";
import { MemoryPageContent } from "./memory-page-content";

export const metadata: Metadata = {
  title: "Memory",
  description:
    "Notes distilled from your chats, and the organisation's shared memory.",
};

/**
 * Unlike `/settings/agents`, this page is not admin-gated as a whole —
 * every signed-in user has their own memory to read, edit, and delete. Only
 * the second, organisation-wide section is admin only, decided inside
 * `MemoryPageContent` (and enforced again, server-side, by `requireAdmin`
 * in `./actions.ts` regardless of what the client renders).
 */
export default function MemoryPage() {
  return <MemoryPageContent />;
}
