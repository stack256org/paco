import "server-only";

import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

/**
 * Everyone with an account on this instance.
 *
 * Paco is self-hosted, so "who can sign in here" is a question only the person
 * running it can answer, and until now nothing in the UI answered it — the
 * Users entry led to Profile, which shows one account: your own.
 *
 * Deliberately selects columns rather than the whole row. The table also holds
 * an avatar URL and verification state, none of which this list needs, and a
 * `select()` with no projection would happily start returning any column added
 * later.
 */
export type AdminUser = {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  isAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date;
};

export async function listUsers(): Promise<AdminUser[]> {
  return await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
}
