"use server";

import { getOrganization } from "@/lib/org/organization";
import { promoteToOrgMemory } from "./org-writer";

/**
 * This module is `"use server"`, so EVERY exported async function in it is a
 * POST-able endpoint whose action id ships to the browser (a client
 * component, `app/settings/memory/memory-page-content.tsx`, imports it).
 * Nothing may be exported from here that is not itself authorized.
 *
 * That is why the actual org-memory writer lives in `./org-writer.ts`, an
 * ordinary module: it takes `organizationId` as an argument and checks
 * nothing, so exporting it from here would hand any caller a write into
 * org-shared memory — which is injected into agent turns by
 * `load-for-turn.ts`.
 */

export type PromoteMemoryResult =
  | { ok: true; promoted: true; slug: string }
  | { ok: false; error: string };

/**
 * The server action a memory entry's "propose for org memory" button calls.
 *
 * Used to branch on whether the caller was an administrator — a member's
 * proposal filed a `blocked` task for an admin to review instead of writing
 * directly. That distinction no longer exists: this instance has one
 * tenant, so every proposal writes immediately.
 */
export async function promoteMemoryAction(params: {
  title: string;
  body: string;
}): Promise<PromoteMemoryResult> {
  const organization = await getOrganization();

  const { slug } = await promoteToOrgMemory({
    organizationId: organization.id,
    title: params.title,
    body: params.body,
  });
  return { ok: true, promoted: true, slug };
}
