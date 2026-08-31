import type { Metadata } from "next";
import { MemoryPageContent } from "./memory-page-content";

export const metadata: Metadata = {
  title: "Memory",
  description:
    "Notes distilled from your chats, and the organisation's shared memory.",
};

/**
 * Shows both a personal memory section and the organisation-wide one — the
 * instance has exactly one tenant, so there is no separate admin-only gate
 * for the shared section any more.
 */
export default function MemoryPage() {
  return <MemoryPageContent />;
}
