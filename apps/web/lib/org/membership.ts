import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { organizationMembers } from "@/lib/db/schema";
import { getOrganization } from "./organization";

/** What this user may do in the organisation, or `null` if they are not in it. */
export async function getMemberRole(
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const org = await getOrganization();
  if (!org) {
    return null;
  }

  const [row] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);

  return row?.role ?? null;
}

/**
 * Whether this user may invite people and change instance settings.
 *
 * Owner and admin are the same answer to that question; they differ only in
 * that an owner cannot be removed.
 */
export async function isOrganizationAdmin(userId: string): Promise<boolean> {
  const role = await getMemberRole(userId);
  return role === "owner" || role === "admin";
}
