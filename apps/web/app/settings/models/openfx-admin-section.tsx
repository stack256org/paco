"use client";

import { useSession } from "@/hooks/use-session";
import { OpenFxProviderSection } from "./openfx-provider-section";

/**
 * Gates `OpenFxProviderSection` behind admin status, the same way
 * `/settings/memory` shows its organisation-wide section only to admins
 * (`memory-page-content.tsx`'s own doc: "Unlike `/settings/agents`, this
 * page is not admin-gated as a whole"). `/settings/models` is on every
 * user's sidebar — the model *preference* above this section is personal —
 * but OpenFX's endpoint/key/binary path are instance-wide credentials, so
 * only an admin should even see the option to reconfigure them.
 *
 * Client-side only: `getInstanceSettings`/`updateOpenFxSettings` re-check
 * `requireAdmin()` themselves regardless of what renders here.
 */
export function OpenFxAdminSection() {
  const { isAdmin } = useSession();

  if (!isAdmin) {
    return null;
  }

  return <OpenFxProviderSection />;
}
