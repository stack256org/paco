import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveAppKey } from "@/lib/crypto/secret-box";

/**
 * A preview-scoped credential, for the one case Better Auth's own session
 * cookie cannot cover: a private preview lives on `<slug>.<preview base
 * domain>`, a different host from Paco's own, and Better Auth's cookie is
 * deliberately host-only (see AGENTS.md — cross-subdomain cookies are not an
 * option here, since that would hand every preview's freshly-written, unread
 * agent code the same cookie that opens the whole account). Without this, a
 * private preview could never be opened by anyone, including its own owner:
 * the browser simply has nothing to send.
 *
 * The fix is a second, narrower credential, minted only after the real
 * session cookie has already proven ownership on Paco's own origin (see
 * `apps/web/app/api/preview-auth/grant/route.ts`), then handed to the
 * browser bound to exactly one preview host and good for a few minutes.
 * `/api/preview-auth` (the forward-auth target Traefik calls on every
 * request) accepts either the real session or this token; see
 * `decide-access.ts` and `route.ts` for how the two combine.
 */

/** Cookie name the grant is stored under, scoped to the preview host it was issued for. */
export const PREVIEW_GRANT_COOKIE_NAME = "paco_preview_grant";

/** Path, on a preview host, that hands the grant token from the URL to a cookie. */
export const PREVIEW_GRANT_CONSUME_PATH = "/__paco-preview-auth/consume";

/** Path, on Paco's own origin, where a real session proves preview ownership. */
export const PREVIEW_GRANT_ENDPOINT_PATH = "/api/preview-auth/grant";

/**
 * How long a grant token is good for, from the moment it is minted.
 *
 * Short on purpose — this is a bearer credential for one specific preview
 * host, so a copy sitting in server logs or a browser history is worth
 * little for long. A preview left open in a tab keeps working past this
 * window only because each successful request re-arms nothing; the browser
 * simply repeats the redirect-through-`/grant` dance, which is silent and
 * cheap as long as the real session cookie is still there to authorize it.
 */
const GRANT_TTL_MS = 10 * 60 * 1000;

/** Domain separator for the key this module derives from `APP_SECRET`. Distinct
 * from `secret-box.ts`'s own, so a flaw in one does not expose the other. */
const KEY_INFO = "paco:preview-grant:v1";

function sign(payload: string): string {
  return createHmac("sha256", deriveAppKey(KEY_INFO))
    .update(payload)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Mint a grant token bound to `host`.
 *
 * The same token is used two ways by the caller: once as the `grant` query
 * parameter on the redirect that hands it to the preview host
 * (`PREVIEW_GRANT_CONSUME_PATH`), and again — unchanged — as the cookie
 * value that request sets, so `verifyPreviewGrantToken` is the one function
 * that validates it in both places.
 */
export function createPreviewGrantToken(host: string): { token: string } {
  const expiresAt = Date.now() + GRANT_TTL_MS;
  const payload = `${host}|${expiresAt}`;
  return { token: `${payload}|${sign(payload)}` };
}

/** Seconds to set as a grant cookie's `Max-Age`, kept in step with the TTL above. */
export const PREVIEW_GRANT_MAX_AGE_SECONDS = Math.floor(GRANT_TTL_MS / 1000);

/**
 * Verify a grant token was minted for `host` and has not expired.
 *
 * `host` binding matters as much as the signature: without it, a token
 * minted for one owned preview would double as a bearer credential for
 * *any* preview, not just the one it was issued for. `false` on anything
 * malformed, mismatched, tampered, or expired — the caller's only job is to
 * treat every failure the same way (deny).
 */
export function verifyPreviewGrantToken(
  token: string | null | undefined,
  host: string,
): boolean {
  if (!token) {
    return false;
  }

  // `|`, not `.` — a preview host is itself dot-separated
  // (`<slug>.<preview base domain>`), so splitting the token on `.` would
  // fragment the host across more than the three fields expected here. `|`
  // never appears in a DNS-safe host, in a millisecond timestamp, or in a
  // base64url signature, so it cleanly delimits all three.
  const parts = token.split("|");
  if (parts.length !== 3) {
    return false;
  }

  const [tokenHost, expiresAtRaw, signature] = parts as [
    string,
    string,
    string,
  ];

  if (tokenHost !== host) {
    return false;
  }

  const payload = `${tokenHost}|${expiresAtRaw}`;
  if (!safeEqual(signature, sign(payload))) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  return Number.isFinite(expiresAt) && Date.now() <= expiresAt;
}
