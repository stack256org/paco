import "server-only";

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { checkFetchAllowed, type CapabilityHandlers } from "@paco/plugin-host";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { WebAgentUIMessage } from "@/app/types";
import { appUrl } from "@/lib/app-url";
import { submitChatMessage } from "@/lib/chat/submit-message";
import { db } from "@/lib/db/client";
import { pluginKv, type PluginRow } from "@/lib/db/schema";
import { getChatById, getSessionById } from "@/lib/db/sessions";

const NET_FETCH_TIMEOUT_MS = 10_000;
const NET_FETCH_BODY_CAP_BYTES = 1_000_000; // 1MB
/** Manual-redirect hops a single `net:fetch` call will follow. */
const NET_FETCH_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Loopback, link-local, and RFC1918/RFC4193 private ranges — the addresses a
 * plugin must never reach through `net:fetch`, no matter what hostname or
 * redirect chain got there. This is the SSRF guard: a granted domain can
 * still resolve (or be redirected, or rebind) to the host's own network, and
 * an exact-hostname allowlist alone says nothing about where that hostname
 * actually points at request time.
 */
function buildPrivateRangesBlockList(): BlockList {
  const blockList = new BlockList();
  blockList.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  blockList.addSubnet("169.254.0.0", 16, "ipv4"); // link-local
  blockList.addSubnet("10.0.0.0", 8, "ipv4"); // private
  blockList.addSubnet("172.16.0.0", 12, "ipv4"); // private
  blockList.addSubnet("192.168.0.0", 16, "ipv4"); // private
  blockList.addSubnet("::1", 128, "ipv6"); // loopback
  blockList.addSubnet("fe80::", 10, "ipv6"); // link-local
  blockList.addSubnet("fc00::", 7, "ipv6"); // unique local
  return blockList;
}

const PRIVATE_RANGES = buildPrivateRangesBlockList();

/**
 * Wires the capability implementations a `PluginHost` calls into once the
 * host has already confirmed the plugin was granted the capability.
 *
 * `pluginRow` is captured once, at host-construction time, and only its
 * static `manifest.netDomains` is read back out of it — the plugin id used
 * to scope every `storage:kv` operation always comes from the `pluginId`
 * argument the host supplies on every call, never from `pluginRow` or from
 * the request payload, so a payload cannot forge its way into another
 * plugin's namespace (spec Section 2 security invariants).
 */
export function buildCapabilityHandlers(
  pluginRow: PluginRow,
): CapabilityHandlers {
  return {
    "storage:kv": (pluginId, payload) => handleStorageKv(pluginId, payload),
    "net:fetch": (_pluginId, payload) => handleNetFetch(pluginRow, payload),
    "messages:post": (pluginId, payload) =>
      handleMessagesPost(pluginId, payload),
  };
}

// --- storage:kv ------------------------------------------------------------

const kvPayloadSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: z.string() }),
  z.object({ op: z.literal("set"), key: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("delete"), key: z.string() }),
  z.object({ op: z.literal("list") }),
]);

async function handleStorageKv(
  pluginId: string,
  payload: unknown,
): Promise<unknown> {
  const parsed = kvPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`storage:kv: invalid payload: ${parsed.error.message}`);
  }

  const op = parsed.data;
  switch (op.op) {
    case "get": {
      const [row] = await db
        .select({ value: pluginKv.value })
        .from(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, op.key)));
      return row ? row.value : null;
    }
    case "set": {
      const [existing] = await db
        .select({ key: pluginKv.key })
        .from(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, op.key)));
      const updatedAt = new Date();
      if (existing) {
        await db
          .update(pluginKv)
          .set({ value: op.value, updatedAt })
          .where(
            and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, op.key)),
          );
      } else {
        await db
          .insert(pluginKv)
          .values({ pluginId, key: op.key, value: op.value, updatedAt });
      }
      return { ok: true };
    }
    case "delete": {
      await db
        .delete(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, op.key)));
      return { ok: true };
    }
    case "list": {
      const rows = await db
        .select({ key: pluginKv.key, value: pluginKv.value })
        .from(pluginKv)
        .where(eq(pluginKv.pluginId, pluginId));
      return rows;
    }
    default: {
      const exhaustive: never = op;
      throw new Error(
        `storage:kv: unhandled op: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// --- net:fetch ---------------------------------------------------------

const fetchPayloadSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export interface NetFetchResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

/**
 * Resolves `hostname` and rejects if any returned address is loopback,
 * link-local, or a private range.
 *
 * This is what actually stops SSRF into the host's own network: an
 * allowlisted *hostname* says nothing about where it resolves at request
 * time — DNS rebinding, a misconfigured internal record, or a redirect can
 * all point a granted domain at `127.0.0.1` or `169.254.169.254`. Checked
 * fresh on every hop (see `fetchFollowingRedirects`), not just the first.
 */
async function assertResolvesToPublicAddress(hostname: string): Promise<void> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (error) {
    throw new Error(
      `net:fetch: could not resolve host ${hostname}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  for (const { address, family } of addresses) {
    if (PRIVATE_RANGES.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new Error(
        `net:fetch: host ${hostname} resolves to a non-public address (${address})`,
      );
    }
  }
}

/**
 * Every check a `net:fetch` target — the original URL, or a redirect's
 * `Location` — must pass before a request is allowed to reach it.
 *
 * `checkFetchAllowed` (`@paco/plugin-host`) is the same allowlist function
 * the host itself runs: http(s) only, no IP-literal host (an allowlist is a
 * list of *names*; a literal can't be checked against it and is exactly the
 * shape an SSRF payload takes), and an exact, normalized `netDomains` match
 * with no subdomain/parent-domain matching either way. Importing it instead
 * of a local copy is what keeps this handler and the host's own check from
 * drifting apart. What it deliberately does not — and cannot — check is
 * where the allowed hostname actually resolves; `assertResolvesToPublicAddress`
 * is this handler's own addition for that.
 */
async function assertNetFetchTargetAllowed(
  target: URL,
  netDomains: string[],
): Promise<void> {
  const decision = checkFetchAllowed(target.toString(), netDomains);
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  await assertResolvesToPublicAddress(decision.hostname);
}

interface NetFetchRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * Fetches with `redirect: "manual"` and walks any redirect chain itself,
 * re-running every allowlist/SSRF check (`assertNetFetchTargetAllowed`) on
 * each `Location` before following it. Letting `fetch` auto-follow
 * redirects would mean the allowlist only ever sees the first hop — a
 * granted domain redirecting to an ungranted one, or to an internal
 * address, would sail straight through.
 */
async function fetchFollowingRedirects(
  initialTarget: URL,
  netDomains: string[],
  init: NetFetchRequestInit,
): Promise<Response> {
  let target = initialTarget;

  for (let hop = 0; hop <= NET_FETCH_MAX_REDIRECTS; hop++) {
    await assertNetFetchTargetAllowed(target, netDomains);

    const response = await fetch(target, { ...init, redirect: "manual" });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (hop === NET_FETCH_MAX_REDIRECTS) {
      throw new Error(
        `net:fetch: exceeded ${NET_FETCH_MAX_REDIRECTS} redirects`,
      );
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        "net:fetch: redirect response is missing a Location header",
      );
    }

    try {
      target = new URL(location, target);
    } catch {
      throw new Error(
        `net:fetch: redirect to an unparsable location ${location}`,
      );
    }
  }

  // Unreachable: the loop above always returns or throws.
  throw new Error(`net:fetch: exceeded ${NET_FETCH_MAX_REDIRECTS} redirects`);
}

/**
 * Enforces the manifest's `netDomains` allowlist a second time, in the web
 * app, and performs the actual outbound request.
 *
 * The host (`PluginHost`, `packages/plugin-host/host.ts`) already runs
 * `checkFetchAllowed` against the initial URL before this handler is ever
 * invoked — this is the second, authoritative layer the spec's Consistency
 * rule calls for, not a redundant no-op: nothing about this handler trusts
 * that the host's check ran, so a future caller that reaches it directly is
 * still safe. This handler goes further than the host's single check: it
 * re-validates every redirect hop and rejects targets that resolve into the
 * host's own network (see `assertNetFetchTargetAllowed`).
 *
 * `pluginRow.manifest.netDomains` is the consented domain list. Task 3's
 * `plugins` row has no separate "consented domains" column — grants are a
 * capability-level allow/deny (`grantedCapabilities`), not a per-domain
 * list — so once `net:fetch` is granted at all, the domains the operator
 * consented to are exactly the ones declared in the manifest stored on that
 * row. That manifest is only ever rewritten by the installer
 * (`upsertPlugin`, `lib/db/plugins.ts`); nothing about a plugin's files
 * changing on disk after install can widen it without a re-install passing
 * back through that path.
 */
async function handleNetFetch(
  pluginRow: PluginRow,
  payload: unknown,
): Promise<NetFetchResult> {
  const parsed = fetchPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`net:fetch: invalid payload: ${parsed.error.message}`);
  }
  const { url, method, headers, body } = parsed.data;
  const netDomains = pluginRow.manifest.netDomains ?? [];

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`net:fetch: unparsable url ${url}`);
  }

  let response: Response;
  try {
    response = await fetchFollowingRedirects(target, netDomains, {
      method: method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(NET_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(
        `net:fetch: request timed out after ${NET_FETCH_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    throw error;
  }

  const bodyText = await readBodyTextCapped(response, NET_FETCH_BODY_CAP_BYTES);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return { status: response.status, headers: responseHeaders, bodyText };
}

/** Reads a response body as text, truncated to `capBytes`. */
async function readBodyTextCapped(
  response: Response,
  capBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value || value.length === 0) {
      continue;
    }

    const remaining = capBytes - total;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }

    const slice =
      value.length > remaining ? value.subarray(0, remaining) : value;
    chunks.push(slice);
    total += slice.length;

    if (slice.length < value.length) {
      await reader.cancel();
      break;
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf-8",
  );
}

// --- messages:post -----------------------------------------------------

const messagesPostPayloadSchema = z.object({
  chatId: z.string(),
  text: z.string(),
});

/**
 * Posts a plugin-originated message into a chat by reusing
 * `submitChatMessage` — the exact function the chat API route calls for a
 * browser-submitted message. That means a plugin message landing mid-turn
 * gets the route's steer/buffered handling for free, instead of a
 * second, drifting implementation of "what happens when a message arrives".
 */
async function handleMessagesPost(
  pluginId: string,
  payload: unknown,
): Promise<unknown> {
  const parsed = messagesPostPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`messages:post: invalid payload: ${parsed.error.message}`);
  }
  const { chatId, text } = parsed.data;

  const chat = await getChatById(chatId);
  if (!chat) {
    throw new Error(`messages:post: chat ${chatId} not found`);
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord) {
    throw new Error(`messages:post: session for chat ${chatId} not found`);
  }

  const message: WebAgentUIMessage = {
    id: `plugin-${pluginId}-${randomUUID()}`,
    role: "user",
    parts: [{ type: "text", text }],
  };

  const outcome = await submitChatMessage({
    chatId,
    sessionId: sessionRecord.id,
    userId: sessionRecord.userId,
    messages: [message],
    requestUrl: appUrl().toString(),
    authSession: null,
    sessionStatus: sessionRecord.status,
    activeStreamId: chat.activeStreamId,
  });

  switch (outcome.kind) {
    case "archived":
      throw new Error(`messages:post: session for chat ${chatId} is archived`);
    case "buffer-failed":
      throw new Error(`messages:post: failed to buffer message for ${chatId}`);
    case "conflict":
      throw new Error(
        `messages:post: chat ${chatId} has a conflicting active stream`,
      );
    case "streaming":
      return { ok: true, runId: outcome.runId };
    default: {
      const exhaustive: never = outcome;
      throw new Error(
        `messages:post: unhandled submitChatMessage outcome: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
