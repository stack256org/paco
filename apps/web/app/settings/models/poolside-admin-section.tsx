"use client";

import type { BackendCapabilities } from "@paco/agent-backend";
import { useSession } from "@/hooks/use-session";
import { PoolsideProviderSection } from "./poolside-provider-section";

/**
 * Gates `PoolsideProviderSection` behind admin status, the same way
 * `/settings/memory` shows its organisation-wide section only to admins
 * (`memory-page-content.tsx`'s own doc: "Unlike `/settings/agents`, this
 * page is not admin-gated as a whole"). `/settings/models` is on every
 * user's sidebar — the model *preference* above this section is personal —
 * but Poolside's base URL, key and binary path are instance-wide
 * credentials, so only an admin should even see the option to reconfigure
 * them.
 *
 * Client-side only: `getInstanceSettings`/`updatePoolsideSettings` re-check
 * `requireAdmin()` themselves regardless of what renders here.
 *
 * `capabilities` is threaded straight through from the server page rather
 * than fetched here — it is what the section derives its "what Poolside
 * chats give up" list from, and computing it needs the backend itself.
 */
export function PoolsideAdminSection({
  capabilities,
}: {
  capabilities: BackendCapabilities;
}) {
  const { isAdmin } = useSession();

  if (!isAdmin) {
    return null;
  }

  return <PoolsideProviderSection capabilities={capabilities} />;
}
