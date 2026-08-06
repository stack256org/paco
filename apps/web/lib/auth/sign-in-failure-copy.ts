/**
 * What a person reads when a sign-in link does not let them in.
 *
 * These states were completely silent. better-auth redirects a failed
 * verification to `errorCallbackURL` with an `error` query parameter — but
 * nothing passed that parameter, so it defaulted to the sign-in
 * `callbackURL` of `/sessions`, whose layout redirects a signed-out visitor to
 * `/` and drops the query string on the way. The user landed back on the
 * marketing page with no message, no explanation and nothing to press.
 *
 * A link expires after ten minutes and can only be used once, so this is not a
 * rare path: taking a while to check your email hits it, clicking the link
 * twice hits it, and a corporate mail scanner that pre-fetches URLs burns the
 * token before the human ever clicks.
 */

export type SignInFailure = "expired-or-used" | "not-allowed" | "unknown";

export type SignInFailureCopy = {
  title: string;
  detail: string;
  /** Whether asking for a fresh link is the way out. */
  canRetry: boolean;
};

const COPY: Record<SignInFailure, SignInFailureCopy> = {
  "expired-or-used": {
    title: "That sign-in link has expired",
    detail:
      "Links last ten minutes and work only once — and some email systems open them automatically, which uses them up. Enter your email address to get a fresh one.",
    canRetry: true,
  },
  "not-allowed": {
    title: "This Paco isn't accepting new accounts",
    detail:
      "Your email address doesn't have an account here yet, and sign-ups are currently closed. Ask whoever runs this Paco to turn on sign-ups in Settings, then try again.",
    canRetry: false,
  },
  unknown: {
    title: "That sign-in link didn't work",
    detail:
      "It may have expired, been used already, or been changed on the way. Enter your email address to get a fresh one.",
    canRetry: true,
  },
};

/**
 * Map better-auth's error code to a situation.
 *
 * The codes are better-auth's, not ours — an interface we do not control —
 * which is why reading them here is string matching and reading our own copy
 * would not be. `INVALID_TOKEN` covers expiry and reuse alike, because the
 * token is consumed atomically and there is nothing left to tell them apart.
 */
export function readSignInFailure(errorCode: string | null): SignInFailure {
  if (!errorCode) {
    return "unknown";
  }

  const normalized = errorCode.trim().toUpperCase();

  if (
    normalized === "INVALID_TOKEN" ||
    normalized === "EXPIRED_TOKEN" ||
    normalized === "TOKEN_EXPIRED"
  ) {
    return "expired-or-used";
  }

  if (
    normalized === "SIGNUP_DISABLED" ||
    normalized === "USER_NOT_FOUND" ||
    normalized === "FAILED_TO_CREATE_USER"
  ) {
    return "not-allowed";
  }

  return "unknown";
}

export function signInFailureCopy(failure: SignInFailure): SignInFailureCopy {
  return COPY[failure];
}

/**
 * Where a failed verification should land.
 *
 * `/` rather than `/sessions`: the sessions layout bounces a signed-out
 * visitor and takes the query string with it, so an error sent there explains
 * itself to nobody.
 */
export const SIGN_IN_ERROR_CALLBACK_PATH = "/";

/** The query parameter better-auth sets, read back on the landing page. */
export const SIGN_IN_ERROR_PARAM = "error";
