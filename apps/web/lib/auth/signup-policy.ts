import "server-only";

import { APIError } from "better-auth/api";
import { isFirstRun } from "@/lib/auth/first-run";
import { findLiveInvitationByEmail } from "@/lib/org/invitations";

/**
 * Who is allowed to create an account on this installation.
 *
 * Sign-in is a magic link sent to whatever address is typed, and better-auth
 * creates the account if the address is new. Combined with "the first account
 * becomes the administrator", an instance reachable from the internet would
 * hand full control to whoever found the URL first — no password to guess, no
 * step to get wrong.
 *
 * So new accounts are refused unless the address was invited. The one
 * exception is the very first account, because otherwise nobody could ever
 * get in.
 *
 * This used to have a second exception — an administrator could flip an
 * instance-wide "anyone may join" switch. That switch is gone: invitations
 * are what let someone past the first account now.
 *
 * Signing *in* to an existing account is never affected — this only governs
 * creating a new one.
 */

/**
 * The code the landing page reads back to explain a refused sign-up.
 *
 * `sign-in-failure-copy.ts` maps it to a sentence. Keeping the string in one
 * place is what stops the two halves drifting apart — which is exactly how
 * this failed before: the refusal was a plain `Error`, better-auth had nothing
 * to put in the redirect, and the click landed on an empty 500. The person had
 * received a real, working-looking email and then hit a blank page.
 */
export const SIGNUP_DISABLED_CODE = "SIGNUP_DISABLED";

/**
 * Throws when the account may not be created.
 *
 * An `APIError`, not a bare `Error`. better-auth only turns a thrown error
 * into `?error=<code>` on the callback when it carries a status and a code;
 * anything else escapes as an unhandled 500 with no body, which is a blank
 * page at the end of a magic link.
 *
 * The message is deliberately about the *instance*, not the address. Whether
 * a particular email already has an account is not something an unauthenticated
 * caller should be able to learn, and this path is reachable by anyone who can
 * type an address into the form.
 *
 * The very first account is let through unconditionally. Every account after
 * that needs a live invitation for the exact address being created.
 */
export async function assertSignUpAllowed(email: string): Promise<void> {
  if (await isFirstRun()) {
    return;
  }

  if (await findLiveInvitationByEmail(email)) {
    return;
  }

  throw new APIError("FORBIDDEN", {
    code: SIGNUP_DISABLED_CODE,
    message:
      "This Paco instance is invitation-only. Ask an administrator for an invitation.",
  });
}
