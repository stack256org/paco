import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Slack's v0 request signature, verified over the RAW request body.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * CRYPTO CONSTRAINT (spec Section 6 Task 3): this HMAC-SHA256 needs
 * `node:crypto`. It is on the plugin worker's builtin allowlist
 * (`packages/plugin-host/worker-preload.ts`'s `ALLOWED_BUILTINS` --
 * "assert, buffer, crypto, events, fs, ..."), so this file uses the real
 * `createHmac`/`timingSafeEqual` directly. No pure-JS SHA-256 fallback is
 * needed or included: if `crypto` were ever removed from that allowlist,
 * the right fix is restoring it there (it cannot reach a socket, spawn a
 * process, or load native code -- see SECURITY.md's "Why an allowlist"),
 * not reimplementing HMAC in this plugin.
 */

/**
 * Slack recommends rejecting a request whose `X-Slack-Request-Timestamp` is
 * more than five minutes from now, so a captured, still up-to-date
 * signature cannot be replayed indefinitely.
 */
export const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface SignatureVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies `headers`/`rawBody` against Slack's v0 scheme:
 * `v0=HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)`,
 * compared in constant time.
 *
 * `rawBody` MUST be the exact bytes Slack sent (`PluginChannelRequest.rawBody`)
 * -- a re-serialization of the parsed body would not reproduce what Slack
 * actually signed.
 */
export function verifySlackSignature(
  headers: Record<string, string>,
  rawBody: string,
  signingSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SignatureVerification {
  const timestampHeader = headers["x-slack-request-timestamp"];
  const signatureHeader = headers["x-slack-signature"];
  if (!(timestampHeader && signatureHeader)) {
    return { ok: false, reason: "missing signature headers" };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: "invalid timestamp header" };
  }
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }

  const baseString = `v0:${timestampHeader}:${rawBody}`;
  const expectedSignature = `v0=${createHmac("sha256", signingSecret)
    .update(baseString, "utf8")
    .digest("hex")}`;

  const expected = Buffer.from(expectedSignature, "utf8");
  const provided = Buffer.from(signatureHeader, "utf8");
  const matches =
    expected.length === provided.length && timingSafeEqual(expected, provided);

  return matches ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
