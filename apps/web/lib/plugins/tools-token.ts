import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { deriveAppKey } from "@/lib/crypto/secret-box";

/**
 * A scoped, short-lived credential for the standalone plugin MCP bridge
 * server (`scripts/plugin-mcp-server.ts`) to call Paco's internal
 * `plugin-tools` route.
 *
 * That server runs as its own process, spawned by the Claude Code CLI over
 * stdio, so it has no browser session to authenticate with — it carries this
 * token instead, handed to it through its environment
 * (`PACO_INTERNAL_TOKEN`, see `lib/plugins/mcp-bridge.ts`).
 *
 * A single process-lifetime shared secret (this file's previous shape) was
 * not enough: anything holding it could invoke ANY enabled plugin's tools,
 * not just the ones the bridge that received it was actually built for. The
 * fix is to bind the token itself to the exact set of plugin ids it was
 * minted for (plus an expiry) and sign it with a key derived from
 * `APP_SECRET` (`deriveAppKey`, `lib/crypto/secret-box.ts`) — so the route
 * can verify both that the token is genuine AND that the plugin id a
 * request names is one this particular bridge was actually issued for,
 * rejecting everything else even with a valid signature.
 */

/**
 * How long a minted token is good for.
 *
 * A bridge server's whole lifetime is one Claude Code CLI invocation — each
 * turn spawns a fresh `--mcp-config` process (`packages/claude-code/run.ts`),
 * so the token never has to survive past the turn that minted it. Generous
 * rather than tight, unlike the preview grant's 10 minutes: an agentic turn
 * with heavy tool use can run far longer than a browser redirect, and a
 * token that expires mid-turn degrades to every further plugin tool call
 * failing closed (401) rather than the turn itself failing.
 */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/** Domain separator for the key this module derives from `APP_SECRET`. Distinct
 * from `secret-box.ts`'s own key, so a flaw in one does not expose the
 * other. */
const KEY_INFO = "paco:plugin-tools-token:v1";

/** Version prefix, so the token format can change later without guessing at old ones. */
const VERSION = "v1";

interface TokenPayload {
  pluginIds: string[];
  exp: number;
}

function isTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.pluginIds) &&
    record.pluginIds.every((id) => typeof id === "string") &&
    typeof record.exp === "number"
  );
}

function sign(payload: string): string {
  return createHmac("sha256", deriveAppKey(KEY_INFO))
    .update(payload)
    .digest("base64url");
}

/** Constant-time string comparison — a `!==` here would leak the correct
 * signature one byte at a time through response-timing differences. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Mint a token scoped to exactly `pluginIds` — every plugin the bridge
 * receiving this token is allowed to invoke tools on, and nothing else.
 */
export function mintPluginToolsToken(pluginIds: string[]): string {
  const scope = Array.from(new Set(pluginIds)).sort();
  const payload: TokenPayload = {
    pluginIds: scope,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString(
    "base64url",
  );
  return `${VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

export type PluginToolsTokenVerification =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "out-of-scope" };

/**
 * Verify `token` is genuine, unexpired, and scoped to `pluginId`.
 *
 * `"malformed"` covers anything not intact and authentic — missing,
 * truncated, tampered, wrong version, or signed under a different
 * `APP_SECRET` — and `"expired"` a token whose signature checks out but
 * whose window has passed; the internal route maps both to 401. A
 * genuine, unexpired token naming a plugin outside its own scope is
 * `"out-of-scope"`, mapped to 403 instead: the credential itself is not in
 * question, only whether it covers this particular plugin.
 */
export function verifyPluginToolsToken(
  token: string | null | undefined,
  pluginId: string,
): PluginToolsTokenVerification {
  if (!token) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  const [version, payloadB64, signature] = parts as [string, string, string];
  if (version !== VERSION) {
    return { ok: false, reason: "malformed" };
  }
  if (!safeEqual(signature, sign(payloadB64))) {
    return { ok: false, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isTokenPayload(parsed)) {
    return { ok: false, reason: "malformed" };
  }

  if (Date.now() > parsed.exp) {
    return { ok: false, reason: "expired" };
  }
  if (!parsed.pluginIds.includes(pluginId)) {
    return { ok: false, reason: "out-of-scope" };
  }
  return { ok: true };
}
