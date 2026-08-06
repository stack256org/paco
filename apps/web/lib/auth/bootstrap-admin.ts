import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { ensureOrganizationWithOwner } from "@/lib/org/organization";

/**
 * Make the first account on a fresh instance an administrator.
 *
 * Paco is self-hosted and sign-in is by magic link, so nothing in the product
 * could ever grant admin: the column existed, defaulted to false, and no code
 * path set it. The Admin page and the Users page were both unreachable on
 * every installation — the only way in was an UPDATE against the database.
 *
 * The first person to sign in to a self-hosted instance is the person who
 * installed it, which is the same assumption Gitea, Grafana and Sentry make.
 * That same person also becomes the owner of the instance's one organisation.
 *
 * Written as one conditional statement rather than "count, then decide"
 * because two people can sign up at the same moment: with a read followed by a
 * write, both could see an empty table and both become admin. The `NOT EXISTS`
 * is evaluated by the database as part of the update, so the second one to
 * arrive finds the first already promoted and changes nothing.
 */
export async function promoteFirstUserToAdmin(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ isAdmin: true })
    .where(
      and(
        eq(users.id, userId),
        sql`not exists (select 1 from ${users} as existing where existing.is_admin = true and existing.id <> ${userId})`,
        // Belt and braces: never demote, and never touch a row already true.
        ne(users.isAdmin, true),
      ),
    );

  await ensureOrganizationWithOwner(userId);
}
