import { isEmailDeliveryConfigured } from "@/lib/email/mailer";

/**
 * Whether this instance can actually send an email.
 *
 * With `SMTP_HOST` unset — the documented default, and what every quickstart
 * produces — a magic link is written to the server console instead of being
 * delivered. The sign-in form said "Check your email for a sign-in link"
 * anyway, then collapsed to a disabled "Link sent to you@example.com" with no
 * way back. For someone self-hosting Paco who has never opened a server log,
 * that is a permanent lockout on their very first action, described to them as
 * success.
 *
 * Deliberately readable without a session: the person who needs it is by
 * definition not signed in. It reveals only whether an SMTP host is set, which
 * is a property of the deployment rather than of any account.
 */
export async function GET() {
  return Response.json({ deliversEmail: await isEmailDeliveryConfigured() });
}
