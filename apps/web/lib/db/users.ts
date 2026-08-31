import { eq } from "drizzle-orm";
import { db } from "./client";
import { users } from "./schema";

/**
 * Check if a user exists in the database by ID.
 * Returns true if found, false otherwise. Lightweight query (only fetches the ID).
 */
export async function userExists(userId: string): Promise<boolean> {
  const result = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result.length > 0;
}

/**
 * The id of this instance's one remaining user row.
 *
 * There is no more sign-in, so there is no requester to read a `userId`
 * from — but `sessions`, `github_tokens`, `user_preferences` and a few other
 * tables still carry a `NOT NULL` foreign key into `users` (dropped in a
 * later step of this migration, once every reader is gone). Until then, a
 * brand-new row in one of those tables — one with no existing row of its own
 * to carry a `userId` forward from — needs a real, valid value to satisfy
 * that constraint.
 *
 * This is deliberately NOT a stub or a constant: it reads whichever account
 * actually exists on this installation, the same singleton pattern
 * `getOrganization()` uses for the one organisation. It throws rather than
 * inventing an id when the table is empty, which cannot happen on any
 * instance that has ever completed its (now-removed) first-run flow.
 */
export async function getSoleUserId(): Promise<string> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  if (!row) {
    throw new Error(
      "No account exists on this instance yet — nothing to attribute this to.",
    );
  }
  return row.id;
}
