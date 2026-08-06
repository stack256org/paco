import { z } from "zod";

/**
 * Validation for `invitation-actions.ts`.
 *
 * Kept out of that file: it has a top-level `"use server"` directive, under
 * which every export must be an async function, so a plain Zod schema would
 * fail to compile there. See `instance-settings-schemas.ts` for the same
 * split, applied to the settings actions.
 */

export const inviteMemberSchema = z.object({
  email: z.string().trim().pipe(z.email()),
  role: z.enum(["admin", "member"]),
});

/** The id `revokeMemberInvitation` is asked to delete. */
export const invitationIdSchema = z.string().trim().min(1);
