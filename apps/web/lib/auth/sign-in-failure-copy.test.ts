import { describe, expect, test } from "bun:test";
import {
  readSignInFailure,
  SIGN_IN_ERROR_CALLBACK_PATH,
  signInFailureCopy,
} from "./sign-in-failure-copy";

describe("readSignInFailure", () => {
  test("reads the code better-auth actually sets for a spent link", () => {
    // The magic-link plugin calls `redirectWithError("INVALID_TOKEN")` for both
    // an expired token and one that has already been used — they are consumed
    // atomically, so nothing distinguishes them.
    expect(readSignInFailure("INVALID_TOKEN")).toBe("expired-or-used");
  });

  test("tolerates casing and whitespace from the query string", () => {
    expect(readSignInFailure("invalid_token")).toBe("expired-or-used");
    expect(readSignInFailure("  INVALID_TOKEN ")).toBe("expired-or-used");
  });

  test("separates a refused account from a spent link", () => {
    expect(readSignInFailure("SIGNUP_DISABLED")).toBe("not-allowed");
    expect(readSignInFailure("FAILED_TO_CREATE_USER")).toBe("not-allowed");
  });

  test("falls back rather than guessing", () => {
    expect(readSignInFailure("SOMETHING_NEW")).toBe("unknown");
    expect(readSignInFailure(null)).toBe("unknown");
    expect(readSignInFailure("")).toBe("unknown");
  });
});

describe("signInFailureCopy", () => {
  test("every state says what happened and what to do", () => {
    for (const failure of [
      "expired-or-used",
      "not-allowed",
      "unknown",
    ] as const) {
      const copy = signInFailureCopy(failure);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(0);
      // Nothing here names a token, a status code or an internal term.
      expect(`${copy.title} ${copy.detail}`).not.toMatch(
        /INVALID_TOKEN|401|403|callbackURL|better-auth/i,
      );
    }
  });

  test("only the recoverable states invite another attempt", () => {
    expect(signInFailureCopy("expired-or-used").canRetry).toBe(true);
    expect(signInFailureCopy("unknown").canRetry).toBe(true);
    // Asking for another link cannot open a closed instance.
    expect(signInFailureCopy("not-allowed").canRetry).toBe(false);
  });

  test("the expired message explains the mail-scanner case", () => {
    // Corporate link scanners pre-fetch URLs and silently burn single-use
    // tokens, so the user swears they never clicked it.
    expect(signInFailureCopy("expired-or-used").detail).toMatch(
      /automatically/i,
    );
  });
});

describe("SIGN_IN_ERROR_CALLBACK_PATH", () => {
  test("does not point anywhere that redirects a signed-out visitor", () => {
    // `/sessions` was the effective default and its layout bounces to `/`,
    // dropping the error query on the way — which is how this became silent.
    expect(SIGN_IN_ERROR_CALLBACK_PATH).toBe("/");
  });
});
