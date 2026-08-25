"use server";

import { isAdmin } from "@/lib/admin/require-admin";
import { createTask } from "@/lib/db/tasks";
import { SIGNED_OUT } from "@/lib/error-copy";
import { getMemberRole } from "@/lib/org/membership";
import { getOrganization } from "@/lib/org/organization";
import { getServerSession } from "@/lib/session/get-server-session";
import { orgMemoryDir } from "./paths";
import { writeMemory } from "./store";

/**
 * Writes an entry straight into an organisation's shared memory.
 *
 * The only writer of org memory allowed by the plan's memory invariants
 * (org memory is written ONLY by explicit promotion, never by automatic
 * distillation) — always tagged `source: "promoted"`, never `"distilled"`
 * or `"manual"`, so the settings page can tell a promoted entry apart from
 * one an admin typed by hand. `promotedBy` is carried into the written file
 * (`store.ts`'s optional `MemoryEntry.promotedBy`) as the promotion's
 * provenance.
 */
export async function promoteToOrgMemory(params: {
  organizationId: string;
  title: string;
  body: string;
  promotedBy: string;
}): Promise<{ slug: string }> {
  return await writeMemory(orgMemoryDir(params.organizationId), {
    title: params.title,
    body: params.body,
    source: "promoted",
    promotedBy: params.promotedBy,
  });
}

export type PromoteMemoryResult =
  | { ok: true; promoted: true; slug: string }
  | { ok: true; promoted: false; taskId: string }
  | { ok: false; error: string };

/**
 * The server action a memory entry's "propose for org memory" button calls.
 *
 * The admin check comes first and is `isAdmin(userId)` — the same helper
 * every other admin gate on this page uses (`lib/admin/require-admin.ts`),
 * which is an OR of the `users.is_admin` flag and the organisation
 * `admin`/`owner` role. Checking it ahead of, and independently of, org
 * membership matters: a flag-promoted account can legitimately have no
 * membership row at all (see that helper's own docstring), and gating on
 * membership first would wrongly turn such an admin into a proposer.
 *
 * - admin (by flag or by role): writes immediately via `promoteToOrgMemory`
 *   and reports the resulting slug.
 * - a member who isn't an admin: nothing is written. Instead a task is
 *   filed *already* `blocked` — titled "Org memory proposal: <title>", goal
 *   = the proposed body — for an admin to review from the task board and
 *   unblock or reject by hand. `createTask`'s `initialStatus: "blocked"`
 *   (`lib/db/tasks.ts`) creates it there directly; this deliberately does
 *   not walk `todo -> running -> blocked` through `transitionTaskStatus`,
 *   which would fabricate a status history the task never actually had.
 * - anyone who is neither an admin nor a member: rejected before any task
 *   or write is attempted.
 *
 * A proposal task belongs to no session — `tasks.sessionId` is nullable
 * exactly so a proposal names work to consider rather than a repo to act in
 * yet (see the column comment in `lib/db/schema.ts`). A member with no
 * sessions at all can still file a proposal.
 */
export async function promoteMemoryAction(params: {
  title: string;
  body: string;
}): Promise<PromoteMemoryResult> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return { ok: false, error: SIGNED_OUT };
  }
  const userId = session.user.id;

  const organization = await getOrganization();
  if (!organization) {
    return { ok: false, error: "There is no organisation yet." };
  }

  if (await isAdmin(userId)) {
    const { slug } = await promoteToOrgMemory({
      organizationId: organization.id,
      title: params.title,
      body: params.body,
      promotedBy: userId,
    });
    return { ok: true, promoted: true, slug };
  }

  const role = await getMemberRole(userId);
  if (!role) {
    return { ok: false, error: "You must be a member of this organisation." };
  }

  const created = await createTask({
    organizationId: organization.id,
    sessionId: null,
    title: `Org memory proposal: ${params.title}`,
    goal: params.body,
    origin: "user",
    createdBy: userId,
    initialStatus: "blocked",
  });

  return { ok: true, promoted: false, taskId: created.id };
}
