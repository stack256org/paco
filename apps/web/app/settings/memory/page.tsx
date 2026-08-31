import type { Metadata } from "next";
import { MemoryPageContent } from "./memory-page-content";

export const metadata: Metadata = {
  title: "Memory",
  description: "Notes distilled from your chats, kept for this instance.",
};

/**
 * Shows this instance's memory — a single scope. User and organisation
 * memory used to be separate sections here; Phase C removed
 * application-level identity, so there is exactly one tenant and, since
 * then, exactly one memory scope for it to have.
 */
export default function MemoryPage() {
  return <MemoryPageContent />;
}
