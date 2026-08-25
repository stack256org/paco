"use server";

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { createTask, transitionTaskStatus } from "@/lib/db/tasks";
import { sessions } from "@/lib/db/schema";
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
 * one an admin typed by hand.
 *
 * `promotedBy` is accepted for provenance at the call site (and so a future
 * audit trail has somewhere to start), but nothing here persists it: the
 * memory file format (frontmatter `title`/`updatedAt`/`source` plus a body)
 * has no column for who requested a write, only what scope wrote it.
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
  });
}

export type PromoteMemoryResult =
  | { ok: true; promoted: true; slug: string }
  | { ok: true; promoted: false; taskId: string }
  | { ok: false; error: string };

/**
 * The server action a memory entry's "propose for org memory" button calls.
 *
 * Org membership, not admin, is the entry bar — anyone in the organisation
 * may propose a promotion — but only an admin's call actually writes:
 *
 * - admin/owner: writes immediately via `promoteToOrgMemory` and reports
 *   the resulting slug.
 * - anyone else: nothing is written. Instead a `blocked` task titled
 *   "Org memory proposal: <title>" is filed (goal = the proposed body) for
 *   an admin to review from the task board and unblock or reject by hand.
 *   This is the Section 3 tasks table branch of this action; there is no
 *   "Section 3 absent" branch to implement because the tasks table already
 *   exists on this branch (see `lib/db/schema.ts`'s `tasks` export).
 *
 * `createTask` only ever starts a task in `todo` (see `lib/db/tasks.ts`),
 * and there is no helper to create one already `blocked` — so getting there
 * means walking the state machine's two legal edges, `todo -> running`
 * then `running -> blocked`, both defined in `lib/tasks/state.ts`, rather
 * than reaching into the table directly.
 *
 * Every task also needs a `sessionId` (a task always runs in some session's
 * repo), which this settings-page action has no session to offer — the
 * proposer's own most recently created session stands in for one. A member
 * with no session at all cannot file a proposal; that is reported back as
 * an error rather than attempted with a fabricated id.
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

  const role = await getMemberRole(userId);
  if (!role) {
    return { ok: false, error: "You must be a member of this organisation." };
  }

  if (role === "owner" || role === "admin") {
    const { slug } = await promoteToOrgMemory({
      organizationId: organization.id,
      title: params.title,
      body: params.body,
      promotedBy: userId,
    });
    return { ok: true, promoted: true, slug };
  }

  const [recentSession] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(1);

  if (!recentSession) {
    // Not the brief's "Section 3 absent" branch (that one really does return
    // `{ ok: false, error: "admin only" }`) — this is a narrower gap the
    // brief doesn't name: a task needs a session to run in, and a member
    // who has never started one has nothing to attach the proposal to.
    return {
      ok: false,
      error: "Start a session before proposing an org memory entry.",
    };
  }

  const created = await createTask({
    organizationId: organization.id,
    sessionId: recentSession.id,
    title: `Org memory proposal: ${params.title}`,
    goal: params.body,
    origin: "user",
    createdBy: userId,
  });
  await transitionTaskStatus(organization.id, created.id, "running");
  const blocked = await transitionTaskStatus(
    organization.id,
    created.id,
    "blocked",
  );

  return { ok: true, promoted: false, taskId: blocked.id };
}
