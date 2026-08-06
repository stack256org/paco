"use client";

import { AlertTriangle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  readSignInFailure,
  SIGN_IN_ERROR_PARAM,
  signInFailureCopy,
} from "@/lib/auth/sign-in-failure-copy";

/**
 * Explains a sign-in link that did not work.
 *
 * Renders nothing at all in the normal case, so it can sit permanently above
 * the sign-in control. It exists because the failure was previously invisible:
 * better-auth redirected with `?error=INVALID_TOKEN` and no code anywhere read
 * that parameter, so an expired link put the user back on the marketing page
 * with no indication that anything had happened.
 */
export function SignInErrorNotice() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get(SIGN_IN_ERROR_PARAM);

  if (!errorCode) {
    return null;
  }

  const copy = signInFailureCopy(readSignInFailure(errorCode));

  return (
    <div
      className="alert alert-warning alert-soft alert-vertical max-w-md text-left"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
      <div>
        <h3 className="font-bold text-sm">{copy.title}</h3>
        <p className="text-xs">{copy.detail}</p>
      </div>
    </div>
  );
}
