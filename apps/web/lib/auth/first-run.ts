import "server-only";

import { count } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

/**
 * Whether this installation has no accounts at all.
 *
 * The very first account is let through sign-up regardless of invitations —
 * otherwise nobody could ever get in — and the sign-in page uses this same
 * answer to decide which of two shapes to render before anyone has signed in.
 */
export async function isFirstRun(): Promise<boolean> {
  const [row] = await db.select({ total: count() }).from(users);
  return (row?.total ?? 0) === 0;
}
