import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type Invitation,
  invitations,
  organizationMembers,
} from "@/lib/db/schema";
import { getOrganization } from "./organization";

/**
 * Invitations are how anyone other than the first person gets in.
 *
 * The token is a bearer credential: whoever holds it can create an account on
 * this instance. So it is generated from `randomBytes`, never returned by any
 * listing, and single-use — `acceptedAt` is what stops a forwarded link
 * working twice.
 */

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
const EXPIRY_DAYS = 7;

export type PendingInvitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  expiresAt: Date;
  createdAt: Date;
};

function toPending(row: Invitation): PendingInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Withdraw every live invitation for an address.
 *
 * `createInvitation` calls this before inserting, so there is never more than
 * one live invitation for a given email at a time. Without it, re-inviting an
 * address (e.g. Member, then Admin) left two live rows and
 * `findLiveInvitationByEmail` had no principled way to say which one was "the"
 * invitation — and a double-submitted Invite click produced two identical
 * rows, where revoking the one visible in the UI left the other still able to
 * admit its holder.
 */
async function supersedeLiveInvitations(email: string): Promise<void> {
  await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.email, email.trim().toLowerCase()),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );
}

export async function createInvitation(input: {
  email: string;
  role: "admin" | "member";
  invitedBy: string;
}): Promise<{ token: string; invitation: PendingInvitation }> {
  const org = await getOrganization();
  if (!org) {
    throw new Error("There is no organisation to invite anyone to yet.");
  }

  await supersedeLiveInvitations(input.email);

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(invitations)
    .values({
      id: nanoid(),
      organizationId: org.id,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      token,
      invitedBy: input.invitedBy,
      expiresAt,
      acceptedAt: null,
      createdAt: new Date(),
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create the invitation");
  }

  return { token, invitation: toPending(row) };
}

/**
 * An invitation that has not been used and has not run out of time.
 *
 * `createInvitation` keeps this to at most one row per email going forward,
 * but the `ORDER BY` still matters for whatever the database already holds —
 * a row inserted before that guarantee existed, or restored from a backup —
 * so this never depends on an unspecified `rows[0]` picking whichever one
 * Postgres's planner happens to return first.
 */
export async function findLiveInvitationByEmail(
  email: string,
): Promise<Invitation | null> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email.trim().toLowerCase()),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));

  return rows[0] ?? null;
}

/**
 * The address a live invitation token belongs to — nothing else.
 *
 * Backs `GET /api/auth/invitation`, which the sign-in page calls with
 * whatever `?invitation=` it was given so it can prefill the email field.
 * That route is unauthenticated, so this deliberately returns only the
 * email: never the token back, never the role, never whether the token was
 * merely wrong versus expired versus already used — the same
 * indistinguishability `acceptInvitation` maintains, for the same reason.
 * An unknown or expired token returns `null` rather than throwing, so a
 * stale or mistyped link degrades to the ordinary sign-in box instead of an
 * error page.
 */
export async function findLiveInvitationEmailByToken(
  token: string,
): Promise<string | null> {
  const rows = await db
    .select({ email: invitations.email })
    .from(invitations)
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );

  return rows[0]?.email ?? null;
}

/**
 * Mark an invitation used and put its holder in the organisation.
 *
 * Returns false when the token is unknown, already used, or expired — the
 * caller must treat all three the same, because telling them apart tells an
 * attacker which tokens exist.
 */
export async function acceptInvitation(
  token: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!row) {
    return false;
  }

  // `onConflictDoUpdate`, not `onConflictDoNothing`: someone can already be a
  // member — invited once as `member`, invited again later as `admin` — and
  // this invitation is the newer, explicit statement of what they should be.
  // Accepting it and silently keeping their old role would report success
  // while doing nothing, which is worse than either upgrading them or
  // refusing outright. This upgrades them to the invitation's role.
  await db
    .insert(organizationMembers)
    .values({
      organizationId: row.organizationId,
      userId,
      role: row.role,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: row.role },
    });

  return true;
}

export async function listPendingInvitations(): Promise<PendingInvitation[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));

  return rows.map(toPending);
}

export async function revokeInvitation(id: string): Promise<void> {
  await db.delete(invitations).where(eq(invitations.id, id));
}
