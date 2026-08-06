import { findLiveInvitationEmailByToken } from "@/lib/org/invitations";

/**
 * Resolve an invitation token to the address it was sent to.
 *
 * This is what makes `?invitation=<token>` in the emailed link real: the sign-
 * in page reads that parameter and calls this route to prefill the email
 * field, rather than the token sitting in the URL doing nothing while the
 * whole flow is keyed on the address the recipient types in by hand.
 *
 * Deliberately unauthenticated — a signed-out visitor is exactly who needs
 * this — and deliberately returns only the email, never the token or the
 * invited role: a GET here should tell a browser no more than the emailed
 * link itself already told the person holding it. An unknown, expired, or
 * already-accepted token all resolve to `email: null`, the same
 * indistinguishability `acceptInvitation` maintains, so this degrades to the
 * ordinary sign-in box rather than surfacing an error for a stale link.
 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");

  if (!token) {
    return Response.json({ email: null });
  }

  const email = await findLiveInvitationEmailByToken(token);
  return Response.json({ email });
}
