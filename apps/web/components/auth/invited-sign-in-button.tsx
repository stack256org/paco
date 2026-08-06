"use client";

import { useInvitationEmail } from "@/hooks/use-invitation-email";
import { SignInButton } from "./sign-in-button";

type InvitedSignInButtonProps = Omit<
  Parameters<typeof SignInButton>[0],
  "invitedEmail"
>;

/**
 * `SignInButton`, aware of `?invitation=<token>` in the URL.
 *
 * Split out from `SignInButton` itself because `useSearchParams` needs its
 * own `<Suspense>` boundary — the same reason `SignInErrorNotice` is its own
 * component rather than inlined into `SignInPanel`. Its fallback (rendered
 * while that boundary is suspended) is a plain, un-prefilled `SignInButton`:
 * exactly what an ordinary visitor with no invitation link sees anyway.
 */
export function InvitedSignInButton(props: InvitedSignInButtonProps) {
  const invitedEmail = useInvitationEmail();
  return <SignInButton {...props} invitedEmail={invitedEmail} />;
}
