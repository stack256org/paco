import { timingSafeEqual } from "node:crypto";
import { getPlugin } from "@/lib/db/plugins";
import { open } from "@/lib/crypto/secret-box";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getPluginRegistry } from "@/lib/plugins/registry";

/**
 * Generic inbound webhook ingress for a plugin's `channels/*` slot — the
 * edge that turns "Slack (or anything else) sent a POST" into work a plugin
 * worker runs, per the plan's Section 6 Task 1. Paco's core never parses the
 * payload; it authenticates the caller, rate-limits it, and hands the whole
 * request to `PluginHost.deliverIngress`, which routes it to the worker over
 * the same protocol every other capability uses.
 *
 * POST only — no other HTTP method is exported, so Next.js answers those
 * with its default 405.
 *
 * Order of checks, and why:
 *
 * 1. Both path segments are validated against a strict allowlist before any
 *    db or host lookup touches them — same reasoning as the plugin renderer
 *    route (`app/api/plugins/renderer/[pluginId]/[file]/route.ts`).
 * 2. Rate limiting runs before the plugin lookup, keyed on the path alone
 *    (never on anything the caller controls beyond it), so a flood of
 *    requests for an unknown plugin id is bounded exactly like one for a
 *    real, known plugin — this endpoint is reachable by anyone who can send
 *    an HTTP request, unauthenticated.
 * 3. Unknown plugin -> 404. A plugin that exists but has never been given an
 *    ingress secret (never enabled, or enabled before this feature existed)
 *    is treated identically to a bad secret -> 401: there is no legitimate
 *    caller for it yet, and confirming which of "unknown" and
 *    "unconfigured" applies would leak installed-plugin ids to an
 *    unauthenticated caller.
 * 4. The shared secret is compared in constant time, after being unsealed
 *    with the same `lib/crypto/secret-box` every other stored secret in
 *    this codebase uses (`githubTokens.sealedToken`, `smtpPasswordSealed`).
 *    A secret that fails to unseal (corrupted row, or sealed under a
 *    rotated APP_SECRET) is treated as a bad secret, not a 500: from the
 *    caller's side these are indistinguishable, and the operator's fix is
 *    the same either way — re-enable the plugin to mint a fresh one.
 * 5. Only once auth passes does this look at whether the plugin is actually
 *    running, so an attacker probing secrets cannot use response timing (or
 *    the 401-vs-503 distinction) to learn a plugin's up/down state before
 *    they have the secret.
 */

/** Matches `pluginManifestSchema.name` (`packages/plugin-kit/manifest.ts`). */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * A channel key: the slot file's basename (or its exported `name`), which
 * `worker-entry.ts`'s `loadChannels` derives the same way. No `/`, no `..`,
 * nothing path-shaped — this never touches a filesystem here, but the
 * pattern still fails closed on anything that isn't a plain identifier.
 */
const CHANNEL_PATTERN = /^[a-z0-9_-]{1,64}$/;

const INGRESS_SECRET_HEADER = "x-paco-channel-secret";

/** Requests accepted per plugin+channel in one window, before a 429. */
const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * Constant-time comparison of two secrets. Short-circuits on length
 * mismatch — `Buffer.from` on two unequal-length inputs would otherwise
 * throw inside `timingSafeEqual` itself — matching the same tradeoff
 * `lib/crypto/secret-box.ts`'s `open()` already makes for its version tag.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Best-effort JSON.parse of the raw body; `undefined` when it isn't JSON. */
function parseJsonBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pluginId: string; channel: string }> },
) {
  const { pluginId, channel } = await params;

  if (!(PLUGIN_ID_PATTERN.test(pluginId) && CHANNEL_PATTERN.test(channel))) {
    return notFound();
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["channel-ingress", pluginId, channel]),
    limit: RATE_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  if (limited) {
    return limited;
  }

  const plugin = await getPlugin(pluginId);
  if (!plugin) {
    return notFound();
  }

  const providedSecret = request.headers.get(INGRESS_SECRET_HEADER);
  if (!(plugin.ingressSecret && providedSecret)) {
    return unauthorized();
  }

  let expectedSecret: string;
  try {
    expectedSecret = open(plugin.ingressSecret);
  } catch {
    // Corrupted row, or sealed under an APP_SECRET that has since rotated:
    // indistinguishable from "wrong secret" to the caller, and the fix is
    // the same (re-enable the plugin to mint a fresh one).
    return unauthorized();
  }

  if (!timingSafeEqualStrings(providedSecret, expectedSecret)) {
    return unauthorized();
  }

  const host = getPluginRegistry().get(pluginId);
  if (!host || host.state !== "running") {
    return Response.json({ error: "Plugin is not running" }, { status: 503 });
  }

  const rawBody = await request.text();
  const body = parseJsonBody(rawBody);
  const headers: Record<string, string> = {};
  for (const [name, value] of request.headers.entries()) {
    headers[name] = value;
  }

  const outcome = await host.deliverIngress(channel, headers, body, rawBody);

  if (outcome.ok) {
    return Response.json(outcome.body ?? {}, { status: outcome.status });
  }

  if (outcome.reason === "timeout") {
    return Response.json({ error: outcome.error }, { status: 504 });
  }
  // "not-granted" and "not-running" are both "the plugin cannot currently
  // take this request" from the caller's side — see IngressOutcome's doc
  // comment in `@paco/plugin-host`.
  return Response.json({ error: outcome.error }, { status: 503 });
}
