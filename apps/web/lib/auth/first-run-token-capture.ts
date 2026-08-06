import "server-only";

/**
 * How `POST /api/auth/first-run` gets a usable magic-link token out of
 * `auth.api.signInMagicLink` without an email leaving the process.
 *
 * better-auth's magic-link plugin only ever hands the freshly-minted token to
 * whichever `sendMagicLink` callback the plugin is configured with — normally
 * where `lib/auth/config.ts` queues the sign-in email. First-run registration
 * cannot depend on that: SMTP isn't configured yet on a fresh install, and
 * telling the very first person to read a server log to reach their own
 * instance defeats the point of a registration form.
 *
 * So the first-run route passes a capture function through `metadata`.
 * `sendMagicLink` checks for it (via `readTokenCapture`) and, when present,
 * hands the token straight back through the function call and skips queueing
 * an email entirely — the token then gets used immediately, in the same
 * request, to verify and create a session.
 */

const CAPTURE_KEY = "captureToken";

export type TokenCapture = (token: string) => void;

/** Build the `metadata` payload `signInMagicLink` reads the capture out of. */
export function tokenCaptureMetadata(
  capture: TokenCapture,
): Record<string, unknown> {
  return { [CAPTURE_KEY]: capture };
}

/**
 * Read a capture function back out of `sendMagicLink`'s `metadata` argument.
 *
 * `Object.hasOwn` rather than a plain property read: JSON can never carry a
 * function, so today the only way this reads a truthy, callable value is the
 * one legitimate path — this route building `metadata` itself. But a plain
 * `metadata[CAPTURE_KEY]` walks the prototype chain, so a future
 * prototype-pollution bug elsewhere that lets an attacker set
 * `Object.prototype.captureToken` would turn *every* magic-link sign-in,
 * first-run or not, into a call to attacker-controlled code instead of
 * queueing the email it was supposed to send. `hasOwn` closes that off by
 * only ever looking at `metadata`'s own property, never the prototype's.
 */
export function readTokenCapture(metadata: unknown): TokenCapture | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  if (!Object.hasOwn(metadata, CAPTURE_KEY)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[CAPTURE_KEY];
  return typeof value === "function" ? (value as TokenCapture) : null;
}
