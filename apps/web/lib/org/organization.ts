import "server-only";

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { seedDefaultRoster } from "@/lib/db/roster";
import {
  type Organization,
  organizationMembers,
  organizations,
} from "@/lib/db/schema";

/**
 * The one organisation this installation serves.
 *
 * There is deliberately no "create organisation" screen. The organisation is
 * created as a side effect of the first person signing in, because a
 * self-hosted Paco serves exactly one company and asking them to name it
 * before they can use anything is a step with no decision in it.
 */

const DEFAULT_ORGANIZATION_NAME = "Paco";

export async function getOrganization(): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).limit(1);
  return row ?? null;
}

/**
 * Create the organisation and make this user its owner, once.
 *
 * Idempotent by design: it is called on every account creation, and only the
 * first call does anything. Two people signing in at the same moment must not
 * produce two organisations, so the guarantee is not "check, then insert"
 * (that is a race under READ COMMITTED, Postgres's default isolation level
 * for a plain `db.transaction`, since two concurrent transactions can both
 * see zero rows before either commits) — it is the `singleton` unique
 * constraint on `organizations`. Only one row can ever satisfy it, so at most
 * one caller's `INSERT` can succeed.
 *
 * The loser is not an error case: `onConflictDoNothing` turns the constraint
 * violation into "zero rows returned", and this function re-reads the row the
 * winner created instead of throwing. Only the winner inserts the owner
 * membership, so a second caller never becomes a second owner.
 */
export async function ensureOrganizationWithOwner(
  userId: string,
  name?: string,
): Promise<Organization> {
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(organizations)
      .values({
        id: nanoid(),
        name: name?.trim() || DEFAULT_ORGANIZATION_NAME,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: organizations.singleton })
      .returning();

    if (!row) {
      return null;
    }

    await tx
      .insert(organizationMembers)
      .values({
        organizationId: row.id,
        userId,
        role: "owner",
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    return row;
  });

  if (created) {
    // Only the winner reaches this branch, so the roster is seeded exactly
    // once per installation — not on every sign-in, and not for the loser
    // of the race below. Runs after the transaction commits rather than
    // inside it: roster.ts writes through the shared `db` handle, not the
    // transaction's `tx`, so nothing here needs to participate in it.
    await seedDefaultRoster(created.id);
    return created;
  }

  // Lost the race: some other caller's INSERT won. Their transaction has
  // already committed by the time onConflictDoNothing reports the conflict
  // — Postgres makes a conflicting INSERT wait for the other transaction to
  // finish before deciding there's a conflict — so this is guaranteed to see
  // it, not a re-read that might still find nothing.
  const existing = await getOrganization();
  if (!existing) {
    throw new Error("Failed to create or find the organisation");
  }
  return existing;
}

/**
 * Give the organisation a name, once it exists.
 *
 * Called only from first-run registration, after `ensureOrganizationWithOwner`
 * has already created the row with the default name — the registration form
 * offers an organisation name, but better-auth's `user.create` hook has no
 * channel to carry that string into `ensureOrganizationWithOwner` itself, so
 * this renames it as a separate step instead. Silently does nothing for a
 * blank name, which is what "optional" on that field means.
 */
export async function renameOrganization(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  await db
    .update(organizations)
    .set({ name: trimmed })
    .where(eq(organizations.singleton, true));
}
