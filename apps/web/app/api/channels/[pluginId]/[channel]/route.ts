import { timingSafeEqual } from "node:crypto";
import { channelAuthMode } from "@paco/plugin-kit";
import { open } from "@/lib/crypto/secret-box";
import { getPlugin } from "@/lib/db/plugins";
import { getPluginRegistry } from "@/lib/plugins/registry";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";

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
 * 2. Rate limiting runs before the plugin lookup, in two layers, BOTH keyed
 *    on the caller's source IP as well as the path:
 *      - a generous per-IP bucket, across every plugin+channel, so one
 *        source cannot mint an unbounded number of `getPlugin()` (DB) calls
 *        by enumerating plugin ids;
 *      - the per-(plugin, channel, IP) bucket, so a caller who does not have
 *        the secret cannot burn a real integration's whole budget just by
 *        knowing its (public, fixed) plugin id and channel name — a first
 *        cut that keyed on path alone let an unauthenticated attacker 429
 *        the legitimate sender by hammering the same bucket.
 *    Both run before auth, and before the plugin lookup, so an unauthenticated
 *    flood — of a known id, an unknown one, or many enumerated ones — is
 *    bounded before it costs a DB round trip.
 * 3. Unknown plugin -> 404. A plugin that exists but has never been given an
 *    ingress secret (never enabled, or enabled before this feature existed)
 *    is treated identically to a bad secret -> 401: there is no legitimate
 *    caller for it yet, and confirming which of "unknown" and
 *    "unconfigured" applies would leak installed-plugin ids to an
 *    unauthenticated caller.
 * 4. Which auth gate applies is the channel's own manifest declaration
 *    (`channelAuthMode`). For `"shared-secret"` — the default, and what any
 *    channel that says nothing gets — the secret is compared in constant
 *    time, after being unsealed with the same `lib/crypto/secret-box` every
 *    other stored secret in this codebase uses (`githubTokens.sealedToken`,
 *    `smtpPasswordSealed`). A secret that fails to unseal (corrupted row, or
 *    sealed under a rotated APP_SECRET) is treated as a bad secret, not a
 *    500: from the caller's side these are indistinguishable, and the
 *    operator's fix is the same either way — re-enable the plugin to mint a
 *    fresh one. For `"self-verified"` this step is skipped entirely and the
 *    request reaches the worker unauthenticated, because the providers that
 *    need it (Slack) cannot attach a custom header and sign the raw body
 *    instead; the handler's own signature check is then the only gate, which
 *    is why the mode is declared in the manifest the operator consents to.
 * 5. Only once auth passes does this look at whether the plugin is actually
 *    running, so an attacker probing secrets cannot use response timing (or
 *    the 401-vs-503 distinction) to learn a plugin's up/down state before
 *    they have the secret. (A `"self-verified"` channel has no secret to
 *    probe, so it learns nothing this way that its own 401 would not tell
 *    it anyway.)
 * 6. Only once auth AND the running check both pass is the body actually
 *    read, and capped. For `"shared-secret"` that is defense-in-depth
 *    against a compromised secret holder rather than a boundary an
 *    unauthenticated caller can reach; for `"self-verified"` it IS such a
 *    boundary, which is why the cap and both rate limiters above are load
 *    bearing there.
 * 7. Only an allowlisted subset of the request's headers is handed to the
 *    worker — see `FORWARDED_HEADERS`. Everything the operator's browser or
 *    Paco's own proxy attached, this route's own ingress secret included,
 *    stops here.
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

/**
 * The only request headers a plugin worker is ever shown.
 *
 * This route used to copy `request.headers` verbatim into the ingress
 * message. That is a credential handover: the endpoint is public, and on a
 * `"self-verified"` channel it is unauthenticated, so a cross-site POST that
 * carries the operator's Paco session cookie handed a third-party plugin a
 * live session — which it can read in its `channels/*` handler and ship
 * straight back out through `net:fetch`. `SameSite=Lax` turns away the plain
 * cross-site case, but design previews are served from a subdomain of the
 * app's own domain in the natural deployment, which makes agent-authored
 * preview HTML same-site and the cookie eligible again.
 *
 * An allowlist, not a denylist: a denylist has to enumerate every header
 * that will ever carry a secret, and the next proxy or provider to add one
 * silently defeats it. The cost is that a channel needing a header not
 * listed here requires a change to this file, which is the intended
 * tradeoff — nothing reaches untrusted plugin code without someone
 * deciding it should.
 *
 * Deliberately absent, beyond the obvious `cookie`/`authorization`:
 * `x-paco-channel-secret` (Paco's own ingress credential, consumed by this
 * route and no business of the plugin's) and the proxy headers
 * `x-real-ip`/`x-forwarded-for` (this route's rate-limit identity, not
 * something a worker needs to know).
 */
const FORWARDED_HEADERS: readonly string[] = [
  // Every channel: how to interpret the raw body it is handed.
  "content-type",
  "content-length",
  "user-agent",
  // Slack, whose Event Subscriptions cannot attach a custom header and
  // sign the raw body instead — the whole reason `"self-verified"` exists.
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
  // GitHub-shaped webhooks, the other common signed-body provider.
  "x-github-event",
  "x-github-delivery",
  "x-hub-signature",
  "x-hub-signature-256",
];

/** Copies only `FORWARDED_HEADERS` out of the inbound request. */
function forwardableHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers[name] = value;
    }
  }
  return headers;
}

/** Requests accepted per plugin+channel+source IP in one window, before a 429. */
const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * A much larger ceiling on one source IP alone, across EVERY plugin+channel
 * combination it tries. Bounds the aggregate `getPlugin()` (DB) calls one
 * source can cause by enumerating plugin ids — the per-(plugin, channel, IP)
 * bucket below only bounds requests aimed at one id at a time, so without
 * this an attacker mints a fresh 60-request budget per id it tries.
 */
const IP_RATE_LIMIT = 300;
const IP_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Ceiling on the request body, enforced only after auth and the running
 * check both pass (see the ordering note above) — this is defense-in-depth
 * against a compromised secret, not a boundary an unauthenticated caller
 * can reach. 1 MiB is comfortably above any Slack event payload, and well
 * below anything that would meaningfully strain the worker's stdin pipe
 * (worker -> host lines are separately capped at 64 KiB in `@paco/plugin-host`;
 * this direction has no such cap upstream of this route).
 */
const MAX_INGRESS_BODY_BYTES = 1_048_576;

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * The caller's source IP, for rate limiting only — never for auth.
 *
 * Next.js's `Request` has no direct socket access, so this reads what the
 * reverse proxy in front of it wrote. WHICH header, and which end of it, is
 * the whole point:
 *
 * - `X-Real-IP` is preferred, because Paco's own nginx sets it with
 *   `proxy_set_header X-Real-IP $remote_addr` — a REPLACE. Whatever the
 *   client sent is discarded, so this value is the socket peer nginx
 *   actually saw.
 * - `X-Forwarded-For` is the fallback, and the LAST entry is taken, not the
 *   first. Paco's nginx sets it with `$proxy_add_x_forwarded_for`, which
 *   APPENDS `$remote_addr` to whatever the client already sent. So a caller
 *   who sends `X-Forwarded-For: 1.2.3.4` has that value survive at the
 *   FRONT, and nginx's trustworthy value lands at the back. Reading the
 *   first entry — as this did originally — let any caller pick their own
 *   rate-limit bucket: rotate a forged value per request to evade the
 *   limiter entirely, or forge the real integration's IP to land in its
 *   bucket and 429 it, which is the exact attack the per-IP key exists to
 *   prevent.
 *
 * Both nginx configs that front this are in-repo and set both headers this
 * way: `packaging/debian/postinst` and `lib/preview/nginx-config.ts`. The
 * last-entry rule assumes that single hop; behind a different topology
 * (another proxy in front of nginx) the trustworthy entry moves, and this
 * would need to skip a known number of hops instead.
 *
 * With neither header — a direct connection that bypassed nginx entirely,
 * i.e. local development — every such caller shares one `"unknown"` bucket.
 * That is deliberate: a deployment where this is reachable without the proxy
 * has no trustworthy source identity to offer, so one shared bucket is the
 * honest answer rather than a per-caller one derived from something the
 * caller controls.
 */
function clientIp(request: Request): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  const lastForwarded = forwarded?.split(",").at(-1)?.trim();
  return lastForwarded || "unknown";
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

/**
 * Reads the request body as text, refusing anything past `maxBytes` rather
 * than buffering it all first — a `Content-Length` past the cap is rejected
 * without reading a byte, and a body that lies about (or omits) its length
 * is still caught while streaming, so it never fully lands in memory.
 */
async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    return { ok: false };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, text: "" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(combined) };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ pluginId: string; channel: string }> },
) {
  const { pluginId, channel } = await params;

  if (!(PLUGIN_ID_PATTERN.test(pluginId) && CHANNEL_PATTERN.test(channel))) {
    return notFound();
  }

  const ip = clientIp(request);

  const ipLimited = await checkRateLimit({
    key: rateLimitKey(["channel-ingress-ip", ip]),
    limit: IP_RATE_LIMIT,
    windowMs: IP_RATE_LIMIT_WINDOW_MS,
  });
  if (ipLimited) {
    return ipLimited;
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["channel-ingress", pluginId, channel, ip]),
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

  /*
   * Which gate this channel gets, per its manifest declaration.
   *
   * `"self-verified"` skips the shared-secret comparison ONLY. It exists
   * because the providers this route is for cannot send a custom header:
   * Slack's Event Subscriptions UI takes a Request URL and nothing else, and
   * signs the raw body instead (`x-slack-signature`). A channel that opts in
   * is stating that its own handler verifies the request, so the request
   * reaches the worker unauthenticated and the handler's signature check is
   * the only thing standing in the way — which is why it is declared in the
   * manifest, where the operator sees it on the consent screen, rather than
   * decided by plugin code at runtime.
   *
   * Everything else below still applies to it: the `channels:ingress` grant
   * check and the running-plugin check inside `deliverIngress`, both rate
   * limiters above (which matter MORE here, not less, since there is no
   * secret to turn away an unauthenticated flood), and the body size cap.
   */
  if (channelAuthMode(plugin.manifest, channel) === "shared-secret") {
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
  }

  const host = getPluginRegistry().get(pluginId);
  if (!host || host.state !== "running") {
    return Response.json({ error: "Plugin is not running" }, { status: 503 });
  }

  const bodyResult = await readBodyWithLimit(request, MAX_INGRESS_BODY_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: "Request body too large" }, { status: 413 });
  }
  const rawBody = bodyResult.text;
  const body = parseJsonBody(rawBody);
  const headers = forwardableHeaders(request);

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
