"use server";

import type { z } from "zod";
import { appUrl } from "@/lib/app-url";
import { userExistsByEmail } from "@/lib/db/users";
import { buildInvitationEmail } from "@/lib/email/invitation-email";
import { resolveSmtpConfig } from "@/lib/email/smtp-config";
import { enqueue, QUEUES } from "@/lib/jobs/queue";
import {
  createInvitation,
  listPendingInvitations,
  type PendingInvitation,
  revokeInvitation,
} from "@/lib/org/invitations";
import { getServerSession } from "@/lib/session/get-server-session";
import { invitationIdSchema, inviteMemberSchema } from "./invitation-schemas";
import { requireAdmin } from "./require-admin";

/** Everyone who has been invited and hasn't accepted or expired yet. */
export async function getPendingInvitations(): Promise<PendingInvitation[]> {
  await requireAdmin();
  return await listPendingInvitations();
}

/**
 * Invite someone to the organisation.
 *
 * An invitation is the only way anyone but the first account gets in, so this
 * refuses early and clearly rather than let a submission look successful and
 * quietly go nowhere:
 *
 * - an address that already has an account has nothing to invite,
 * - and with no mail server configured, the email this creates would queue
 *   forever and never arrive — the invitation would look sent and never be.
 */
export async function inviteMember(
  input: z.infer<typeof inviteMemberSchema>,
): Promise<{ success: boolean; error?: string }> {
  const adminId = await requireAdmin();

  const parsed = inviteMemberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "That doesn't look right.",
    };
  }

  const { email, role } = parsed.data;

  if (await userExistsByEmail(email)) {
    return {
      success: false,
      error: `${email} already has an account on this instance.`,
    };
  }

  if (!(await resolveSmtpConfig())) {
    return {
      success: false,
      error:
        "Set a mail server in Settings before inviting anyone — there is nothing to send the invitation with yet.",
    };
  }

  const session = await getServerSession();
  const invitedByEmail = session?.user?.email ?? "An administrator";

  const { token, invitation } = await createInvitation({
    email,
    role,
    invitedBy: adminId,
  });

  await enqueue(QUEUES.sendEmail, {
    to: invitation.email,
    ...buildInvitationEmail({
      url: `${appUrl().origin}/?invitation=${token}`,
      invitedByEmail,
      expiresAt: invitation.expiresAt,
    }),
  });

  return { success: true };
}

/** Withdraw an invitation before it's accepted. */
export async function revokeMemberInvitation(
  id: z.infer<typeof invitationIdSchema>,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();

  const parsed = invitationIdSchema.safeParse(id);
  if (!parsed.success) {
    return { success: false, error: "That invitation could not be found." };
  }

  await revokeInvitation(parsed.data);
  return { success: true };
}
