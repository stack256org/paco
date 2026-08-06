import "server-only";

import { isUserAdmin } from "@/lib/db/users";
import { NOT_YOURS, SIGNED_OUT } from "@/lib/error-copy";
import { isOrganizationAdmin } from "@/lib/org/membership";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Whether this user may act as an administrator.
 *
 * Two, independent sources both count, and the check is an OR of them — never
 * a replacement of one by the other:
 *
 * - `users.is_admin`, set for the very first account by
 *   `promoteFirstUserToAdmin`, and for anyone migration `0005` promoted on an
 *   upgraded install (see that migration's comment: only the oldest such
 *   account becomes an org `owner`; the rest keep `is_admin` with no org role
 *   at all).
 * - the organisation `admin`/`owner` role, granted through an invitation.
 *
 * Dropping either half regresses someone who currently has access: dropping
 * the org check strands every admin invited after phase 2 shipped (their
 * `is_admin` is false — see `requireAdmin`'s own history, where this was the
 * bug), and dropping the `is_admin` check strands the accounts migration
 * `0005` didn't make an owner.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const [byFlag, byOrgRole] = await Promise.all([
    isUserAdmin(userId),
    isOrganizationAdmin(userId),
  ]);
  return byFlag || byOrgRole;
}

/**
 * The gate on every administrator-only action.
 *
 * Shared rather than repeated per action file: an admin check that exists in
 * two places is an admin check that will exist in one place after the next
 * refactor. Throws rather than returning a flag, so an action that forgets to
 * read the answer still fails closed.
 */
export async function requireAdmin(): Promise<string> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error(SIGNED_OUT);
  }
  if (!(await isAdmin(session.user.id))) {
    throw new Error(NOT_YOURS);
  }
  return session.user.id;
}
