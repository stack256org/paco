import "server-only";

import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList } from "node:net";
import { checkFetchAllowed, type CapabilityHandlers } from "@paco/plugin-host";
import { and, asc, eq, gt } from "drizzle-orm";
import { Agent, type Dispatcher } from "undici";
import { z } from "zod";
import type { WebAgentUIMessage } from "@/app/types";
import { appUrl } from "@/lib/app-url";
import { submitChatMessage } from "@/lib/chat/submit-message";
import { db } from "@/lib/db/client";
import { pluginKv, type PluginRow } from "@/lib/db/schema";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { createTask } from "@/lib/db/tasks";
import { getOrganization } from "@/lib/org/organization";
import { sessionBelongsToOrganization } from "@/lib/tasks/planner";
import { startTask } from "@/lib/tasks/start";

const NET_FETCH_TIMEOUT_MS = 10_000;
const NET_FETCH_BODY_CAP_BYTES = 1_000_000; // 1MB
/** Manual-redirect hops a single `net:fetch` call will follow. */
const NET_FETCH_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** `storage:kv` limits (Task 6 fix round 2): a runaway plugin cannot grow
 * one key past this, list past a page, or a key name past this length. */
const KV_KEY_MAX_LENGTH = 256;
const KV_VALUE_MAX_BYTES = 64 * 1024;
const KV_LIST_LIMIT = 1000;

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
    "tasks:create": (_pluginId, payload) => handleTasksCreate(payload),
  };
}

// --- storage:kv ------------------------------------------------------------

const kvKeySchema = z.string().min(1).max(KV_KEY_MAX_LENGTH);

/**
 * A value is accepted only if it is JSON-serializable (it is about to be
 * stored as jsonb — a circular structure or a `bigint` fails at the
 * database, not here, if this doesn't catch it first) and its serialized
 * form fits the 64 KiB cap.
 */
const kvValueSchema = z.unknown().refine(
  (value) => {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return false;
    }
    const byteLength =
      serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf-8");
    return byteLength <= KV_VALUE_MAX_BYTES;
  },
  {
    message: `value must be JSON-serializable and at most ${KV_VALUE_MAX_BYTES} bytes serialized`,
  },
);

const kvPayloadSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), key: kvKeySchema }),
  z.object({ op: z.literal("set"), key: kvKeySchema, value: kvValueSchema }),
  z.object({ op: z.literal("delete"), key: kvKeySchema }),
  z.object({
    op: z.literal("list"),
    /** Last key from a previous page; omit to start from the beginning. */
    afterKey: kvKeySchema.optional(),
  }),
]);

export interface KvListResult {
  items: Array<{ key: string; value: unknown }>;
  /** Present iff the page was full — pass back as `afterKey` for the next one. */
  nextAfterKey?: string;
}

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
      // A single upsert, not a select-then-branch: two concurrent `set`
      // calls for the same key raced the old select-then-insert-or-update
      // shape into either a duplicate-key error or a lost update. The
      // database's own conflict handling is the only thing that can make
      // this atomic.
      await db
        .insert(pluginKv)
        .values({
          pluginId,
          key: op.key,
          value: op.value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pluginKv.pluginId, pluginKv.key],
          set: { value: op.value, updatedAt: new Date() },
        });
      return { ok: true };
    }
    case "delete": {
      await db
        .delete(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, op.key)));
      return { ok: true };
    }
    case "list": {
      const conditions = [eq(pluginKv.pluginId, pluginId)];
      if (op.afterKey !== undefined) {
        conditions.push(gt(pluginKv.key, op.afterKey));
      }

      const rows = await db
        .select({ key: pluginKv.key, value: pluginKv.value })
        .from(pluginKv)
        .where(and(...conditions))
        .orderBy(asc(pluginKv.key))
        .limit(KV_LIST_LIMIT);

      const result: KvListResult = { items: rows };
      if (rows.length === KV_LIST_LIMIT) {
        result.nextAfterKey = rows.at(-1)?.key;
      }
      return result;
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
 * Resolves `hostname` and returns ONE validated address to pin the
 * connection to, rejecting if any returned address is loopback, link-local,
 * or a private range.
 *
 * Returning the address (not just validating it) is what closes the
 * DNS-rebind gap: if this function only said "yes, resolves publicly" and
 * `fetch` re-resolved the hostname itself when it actually connects, an
 * attacker-controlled DNS record could answer differently the second time —
 * publicly-routable here, `169.254.169.254` a moment later. The caller pins
 * the socket to exactly this address (`pinnedDispatcher`) so there is no
 * second, independent lookup to race.
 */
async function resolveValidatedAddress(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
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

  if (addresses.length === 0) {
    throw new Error(
      `net:fetch: host ${hostname} did not resolve to any address`,
    );
  }

  for (const { address, family } of addresses) {
    if (PRIVATE_RANGES.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new Error(
        `net:fetch: host ${hostname} resolves to a non-public address (${address})`,
      );
    }
  }

  const [first] = addresses;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

interface ValidatedNetFetchTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/**
 * Every check a `net:fetch` target — the original URL, or a redirect's
 * `Location` — must pass before a request is allowed to reach it, plus the
 * exact address that check resolved, for the caller to pin the connection
 * to.
 *
 * `checkFetchAllowed` (`@paco/plugin-host`) is the same allowlist function
 * the host itself runs: http(s) only, no IP-literal host (an allowlist is a
 * list of *names*; a literal can't be checked against it and is exactly the
 * shape an SSRF payload takes), and an exact, normalized `netDomains` match
 * with no subdomain/parent-domain matching either way. Importing it instead
 * of a local copy is what keeps this handler and the host's own check from
 * drifting apart. What it deliberately does not — and cannot — check is
 * where the allowed hostname actually resolves; `resolveValidatedAddress`
 * is this handler's own addition for that.
 */
async function assertNetFetchTargetAllowed(
  target: URL,
  netDomains: string[],
): Promise<ValidatedNetFetchTarget> {
  const decision = checkFetchAllowed(target.toString(), netDomains);
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }

  const { address, family } = await resolveValidatedAddress(decision.hostname);
  return { hostname: decision.hostname, address, family };
}

/**
 * Builds a per-request undici dispatcher whose socket connects to exactly
 * `address` — an override of undici's `connect.lookup`, which otherwise
 * asks the OS resolver again at connect time, is the only way to make the
 * validated address in `resolveValidatedAddress` the one actually dialed.
 * The request's Host header and TLS SNI still come from `target`'s
 * hostname (undici derives both from the URL, not from `connect.lookup`),
 * so this narrows *what IP is dialed*, not what the server sees.
 *
 * One dispatcher per hop, closed as soon as that hop's response is no
 * longer needed (`fetchFollowingRedirects`/`handleNetFetch`) — an undici
 * `Agent` holds pooled connections open until told otherwise.
 */
function pinnedDispatcher(address: string, family: 4 | 6): Dispatcher {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, address, family);
      },
    },
  });
}

interface NetFetchRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * `dispatcher` is a Node/undici extension to `fetch`'s options — lib.dom's
 * `RequestInit` (what this project's tsconfig pulls `fetch`'s types from)
 * has no idea it exists. This is a type-only widening for the one call site
 * that needs it; the Node/undici runtime honors `dispatcher` regardless of
 * what lib.dom declares.
 */
type FetchInitWithDispatcher = RequestInit & { dispatcher: Dispatcher };

interface NetFetchAttempt {
  response: Response;
  dispatcher: Dispatcher;
}

/**
 * Fetches with `redirect: "manual"` and walks any redirect chain itself,
 * re-running every allowlist/SSRF/pinning check (`assertNetFetchTargetAllowed`)
 * on each `Location` before following it. Letting `fetch` auto-follow
 * redirects would mean the allowlist only ever sees the first hop — a
 * granted domain redirecting to an ungranted one, or to an internal
 * address, would sail straight through.
 *
 * Returns the dispatcher that produced the final response alongside it:
 * that dispatcher must stay open until the response body has been read
 * (`handleNetFetch`), while every earlier hop's dispatcher — whose body is
 * never consumed — is closed here as soon as its redirect is resolved.
 */
async function fetchFollowingRedirects(
  initialTarget: URL,
  netDomains: string[],
  init: NetFetchRequestInit,
): Promise<NetFetchAttempt> {
  let target = initialTarget;
  let previousDispatcher: Dispatcher | undefined;

  for (let hop = 0; hop <= NET_FETCH_MAX_REDIRECTS; hop++) {
    const validated = await assertNetFetchTargetAllowed(target, netDomains);

    if (previousDispatcher) {
      await previousDispatcher.close();
    }
    const dispatcher = pinnedDispatcher(validated.address, validated.family);
    previousDispatcher = dispatcher;

    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        redirect: "manual",
        dispatcher,
      } as FetchInitWithDispatcher);
    } catch (error) {
      // `fetch` itself threw (network error, TLS failure, the shared
      // AbortSignal.timeout firing mid-hop) — this hop's dispatcher was
      // never handed back to a caller that could close it, so it must be
      // closed here or it leaks. `previousDispatcher.close()` only runs at
      // the top of the *next* iteration, which this throw skips entirely.
      await dispatcher.close();
      throw error;
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, dispatcher };
    }

    if (hop === NET_FETCH_MAX_REDIRECTS) {
      await dispatcher.close();
      throw new Error(
        `net:fetch: exceeded ${NET_FETCH_MAX_REDIRECTS} redirects`,
      );
    }

    const location = response.headers.get("location");
    if (!location) {
      await dispatcher.close();
      throw new Error(
        "net:fetch: redirect response is missing a Location header",
      );
    }

    try {
      target = new URL(location, target);
    } catch {
      await dispatcher.close();
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

  let attempt: NetFetchAttempt;
  try {
    attempt = await fetchFollowingRedirects(target, netDomains, {
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

  const { response, dispatcher } = attempt;
  try {
    const bodyText = await readBodyTextCapped(
      response,
      NET_FETCH_BODY_CAP_BYTES,
    );
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return { status: response.status, headers: responseHeaders, bodyText };
  } finally {
    await dispatcher.close();
  }
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
    // Attribution: the chat transcript otherwise has no way to tell a
    // plugin-posted message apart from one the person using the chat typed
    // themselves. `postedBy` rides along in the message's own metadata —
    // stored verbatim by the existing persistence path — and the chat UI
    // (session-chat-content.tsx) reads it back to show a small badge.
    metadata: { postedBy: { kind: "plugin", pluginId } },
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

// --- tasks:create ------------------------------------------------------

const tasksCreatePayloadSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  autoStart: z.boolean().optional(),
});

export interface TasksCreateResult {
  taskId: string;
  chatId?: string;
  /** Set when `autoStart` was requested but `startTask` failed. */
  error?: string;
}

/**
 * Creates a task on the board from an inbound channel message — the
 * mechanism behind "mention the bot -> task appears" — and, if `autoStart`
 * is set, starts it the same way the board's own "start" action does.
 *
 * Sessions are user-scoped, not org-scoped (`lib/db/schema.ts`), so the only
 * way to check a session belongs to the instance this plugin runs in is the
 * same membership check `planGoal` uses for the identical problem:
 * `sessionBelongsToOrganization` is imported from `lib/tasks/planner.ts`
 * rather than re-derived here, so the two call sites can never drift into
 * checking different things. An unknown session id and a session that
 * belongs to someone else's organization are reported with the exact same
 * error — a plugin must not be able to tell "no such session" apart from
 * "not yours" (same reasoning as `messages:post` and `planGoal` before it).
 *
 * `origin: "channel"` is hardcoded here, never read from the payload — a
 * plugin chooses `title`/`goal`/`sessionId`/`autoStart`, nothing else, so it
 * cannot smuggle a task onto the board tagged as though a human or the
 * planner created it, and it cannot pick the task's initial status either
 * (`createTask`'s `initialStatus` is simply never passed, so it defaults to
 * `"todo"`).
 *
 * A failed `autoStart` is returned as `{ taskId, error }`, not thrown: the
 * task itself was already created successfully by that point, and throwing
 * would report the whole call as failed when a task in fact now exists on
 * the board, just without a chat behind it yet.
 */
async function handleTasksCreate(payload: unknown): Promise<TasksCreateResult> {
  const parsed = tasksCreatePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`tasks:create: invalid payload: ${parsed.error.message}`);
  }
  const { sessionId, title, goal, autoStart } = parsed.data;

  const notFoundError = new Error(
    `tasks:create: session "${sessionId}" not found`,
  );

  const [session, organization] = await Promise.all([
    getSessionById(sessionId),
    getOrganization(),
  ]);
  if (!session || !organization) {
    throw notFoundError;
  }
  if (!(await sessionBelongsToOrganization(session.userId, organization.id))) {
    throw notFoundError;
  }

  const task = await createTask({
    organizationId: organization.id,
    sessionId,
    title,
    goal,
    origin: "channel",
  });

  if (!autoStart) {
    return { taskId: task.id };
  }

  const started = await startTask(organization.id, task.id);
  if (!started.ok) {
    return { taskId: task.id, error: started.error };
  }
  return { taskId: task.id, chatId: started.chatId };
}
