import { eq, sql } from "drizzle-orm";
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
 * Whether an account already exists for this address.
 *
 * Case-insensitive, but not via `ilike`: `email` is user input (an admin
 * typing an address to invite), and `z.email()` accepts `_` — a valid,
 * single-character LIKE wildcard — even though it rejects `%`. `ilike` would
 * let inviting `bob_smith@corp.com` match an unrelated existing
 * `bobXsmith@corp.com` and refuse the invite as "already has an account",
 * with no way for the admin to tell why. Comparing `lower(email)` against
 * the lowercased input is an exact match with no wildcard semantics at all,
 * while still catching an existing `Alice@example.com` when someone later
 * types `alice@example.com` — the case-insensitivity this needs, without the
 * part that doesn't.
 */
export async function userExistsByEmail(email: string): Promise<boolean> {
  const result = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .limit(1);
  return result.length > 0;
}

/**
 * Check if a user has admin privileges.
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  const result = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return result[0]?.isAdmin === true;
}
