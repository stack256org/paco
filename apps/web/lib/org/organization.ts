import "server-only";

import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { seedDefaultRoster } from "@/lib/db/roster";
import { type Organization, organizations } from "@/lib/db/schema";

/**
 * The one organisation this installation serves.
 *
 * There is deliberately no "create organisation" screen, and — since there is
 * no sign-in left to hang the creation off of — no requester to create it
 * either. `getOrganization` creates the row itself, on whichever call
 * happens to be first, rather than requiring some other code path to have
 * called an `ensure...` function first: a self-hosted Paco serves exactly
 * one instance, and there is no decision in naming it, so nothing should be
 * able to observe a moment where it doesn't exist yet.
 */

const DEFAULT_ORGANIZATION_NAME = "Paco";

/**
 * Create the organisation, once. Idempotent and race-safe: two callers
 * arriving at the same moment (the ordinary case, since every caller of
 * `getOrganization` can reach this) must not produce two organisations, so
 * the guarantee is not "check, then insert" (a race under READ COMMITTED,
 * Postgres's default isolation level, since two concurrent transactions can
 * both see zero rows before either commits) — it is the `singleton` unique
 * constraint on `organizations`. Only one row can ever satisfy it, so at most
 * one caller's `INSERT` can succeed; `onConflictDoNothing` turns every other
 * caller's constraint violation into "zero rows returned" rather than a
 * thrown error, and the loser re-reads the winner's row instead of
 * fabricating its own.
 */
async function ensureOrganization(): Promise<Organization> {
  const [created] = await db
    .insert(organizations)
    .values({
      id: nanoid(),
      name: DEFAULT_ORGANIZATION_NAME,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: organizations.singleton })
    .returning();

  if (created) {
    // Only the winner reaches this branch, so the roster is seeded exactly
    // once per installation, never once per caller.
    await seedDefaultRoster(created.id);
    return created;
  }

  // Lost the race: some other caller's INSERT won. Their transaction has
  // already committed by the time onConflictDoNothing reports the conflict
  // — Postgres makes a conflicting INSERT wait for the other transaction to
  // finish before deciding there's a conflict — so this is guaranteed to see
  // it, not a re-read that might still find nothing.
  const [existing] = await db.select().from(organizations).limit(1);
  if (!existing) {
    throw new Error("Failed to create or find the organisation");
  }
  return existing;
}

export async function getOrganization(): Promise<Organization> {
  const [row] = await db.select().from(organizations).limit(1);
  return row ?? (await ensureOrganization());
}
