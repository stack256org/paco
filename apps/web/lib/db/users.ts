import { db } from "./client";
import { users } from "./schema";

/**
 * The id of this instance's one remaining user row.
 *
 * Used ONLY where a write still needs a real, valid `userId` to satisfy a
 * `NOT NULL` foreign key that this phase has not dropped yet —
 * `chatReads.userId` (`markChatRead`, `forkChatThroughMessage`),
 * `sessions.userId` (session creation), `user_preferences.userId`
 * (`updateUserPreferences`'s create path), and `github_tokens.userId`
 * (`saveGithubToken`). Every read this helper used to gate has since been
 * unfiltered instead — the instance has one tenant, so the unfiltered read
 * IS the correct read, and a read needs no id at all. Task 5 drops those
 * four NOT NULL constraints along with the `users` table itself, at which
 * point this function is deleted, not kept around unused.
 *
 * This is deliberately NOT a stub or a constant: it reads whichever account
 * actually exists on this installation, the same singleton pattern
 * `getOrganization()` uses for the one organisation.
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
