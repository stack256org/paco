import { describe, expect, mock, test } from "bun:test";
import type { PluginManifest } from "@paco/plugin-kit";
import { pluginKv, type PluginRow } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type KvRow = { pluginId: string; key: string; value: unknown; updatedAt: Date };
type Predicate = (row: KvRow) => boolean;

/**
 * Same trick as `lib/db/plugins.test.ts` and `lib/db/session-events.test.ts`:
 * a tiny in-memory store plus real column objects from the schema, so a
 * mocked `eq`/`and` can filter it the way Drizzle would filter real rows,
 * without standing up a real Postgres.
 */
const COLUMN_KEYS = new Map<unknown, keyof KvRow>([
  [pluginKv.pluginId, "pluginId"],
  [pluginKv.key, "key"],
]);

function keyFor(column: unknown): keyof KvRow {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

const actualDrizzle = await import("drizzle-orm");

type Order = { direction: "asc" | "desc" };

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  gt:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      (row[keyFor(column)] as string) > (value as string),
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  asc: (_column: unknown): Order => ({ direction: "asc" }),
}));

let kvStore: KvRow[] = [];

function makeKvRow(partial: Partial<KvRow>): KvRow {
  return {
    pluginId: partial.pluginId ?? "plugin-a",
    key: partial.key ?? "k",
    value: partial.value,
    updatedAt: partial.updatedAt ?? new Date(),
  };
}

let insertCalls = 0;
let updateCalls = 0;

const fakeDb = {
  select: (_columns?: Record<string, unknown>) => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) => {
        const filtered = () =>
          kvStore.filter(predicate).map((row) => ({ ...row }));
        return Object.assign(Promise.resolve(filtered()), {
          orderBy: (_order?: Order) => {
            const sorted = () =>
              [...filtered()].sort((a, b) =>
                a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
              );
            return Object.assign(Promise.resolve(sorted()), {
              limit: (n: number) => Promise.resolve(sorted().slice(0, n)),
            });
          },
        });
      },
    }),
  }),
  insert: (_table: unknown) => ({
    values: (value: Partial<KvRow>) => {
      insertCalls++;
      const row = makeKvRow(value);
      return {
        onConflictDoUpdate: (opts: { set: Partial<KvRow> }) => {
          const existing = kvStore.find(
            (candidate) =>
              candidate.pluginId === row.pluginId && candidate.key === row.key,
          );
          if (existing) {
            Object.assign(existing, opts.set);
          } else {
            kvStore.push(row);
          }
          return Promise.resolve();
        },
      };
    },
  }),
  update: (_table: unknown) => ({
    set: (patch: Partial<KvRow>) => ({
      where: (predicate: Predicate) => {
        updateCalls++;
        for (const row of kvStore) {
          if (predicate(row)) {
            Object.assign(row, patch);
          }
        }
        return Promise.resolve();
      },
    }),
  }),
  delete: (_table: unknown) => ({
    where: (predicate: Predicate) => {
      kvStore = kvStore.filter((row) => !predicate(row));
      return Promise.resolve();
    },
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

let chatRow: { sessionId: string; activeStreamId: string | null } | undefined;
let sessionRow: { id: string; userId: string; status: string } | undefined;
const getChatByIdSpy = mock(async (_chatId: string) => chatRow);
const getSessionByIdSpy = mock(async (_sessionId: string) => sessionRow);

mock.module("@/lib/db/sessions", () => ({
  getChatById: getChatByIdSpy,
  getSessionById: getSessionByIdSpy,
}));

type SubmitOutcome =
  | { kind: "archived" }
  | { kind: "buffer-failed" }
  | { kind: "conflict" }
  | { kind: "streaming"; runId: string; stream: ReadableStream<unknown> };

let submitOutcome: SubmitOutcome = {
  kind: "streaming",
  runId: "run-1",
  stream: new ReadableStream(),
};
const submitChatMessageSpy = mock(async (_input: unknown) => submitOutcome);

mock.module("@/lib/chat/submit-message", () => ({
  submitChatMessage: submitChatMessageSpy,
}));

mock.module("@/lib/app-url", () => ({
  appUrl: () => new URL("http://localhost:3000"),
}));

/**
 * `net:fetch` resolves every target host before allowing a request through
 * (the SSRF guard). Defaults every lookup to a public address so existing
 * allow/deny-by-hostname tests don't need to know about DNS; individual
 * tests override `dnsAddresses` to simulate a hostname rebinding to a
 * private/loopback address.
 */
let dnsAddresses: Record<
  string,
  Array<{ address: string; family: number }>
> = {};
const dnsLookupSpy = mock(async (hostname: string) => {
  return dnsAddresses[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
});

mock.module("node:dns/promises", () => ({
  lookup: dnsLookupSpy,
}));

/**
 * `net:fetch` pins its outbound connection to the exact address
 * `resolveValidatedAddress` validated, via an undici `Agent` whose
 * `connect.lookup` ignores whatever hostname it's asked to resolve and
 * always answers with that one address (see `pinnedDispatcher` in
 * capability-handlers.ts). Recording every `Agent` constructor call lets
 * a test invoke that captured `lookup` function directly and prove it does
 * not re-resolve.
 */
interface FakeAgentOptions {
  connect?: {
    lookup?: (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
  };
}

let agentConstructorCalls: FakeAgentOptions[] = [];
let agentCloseCalls = 0;

class FakeDispatcher {
  constructor(opts: FakeAgentOptions) {
    agentConstructorCalls.push(opts);
  }
  close(): Promise<void> {
    agentCloseCalls++;
    return Promise.resolve();
  }
}

mock.module("undici", () => ({
  Agent: FakeDispatcher,
}));

const { buildCapabilityHandlers } = await import("./capability-handlers");

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "my-plugin",
    version: "1.0.0",
    description: "Does a thing.",
    pacoApi: 1,
    capabilities: ["storage:kv", "net:fetch", "messages:post"],
    netDomains: ["api.linear.app"],
    ...overrides,
  };
}

function pluginRow(overrides: Partial<PluginRow> = {}): PluginRow {
  const now = new Date();
  return {
    id: "my-plugin",
    source: "local:/tmp/my-plugin",
    version: "1.0.0",
    contentHash: "sha256:abc",
    manifest: manifest(),
    grantedCapabilities: ["storage:kv", "net:fetch", "messages:post"],
    enabled: true,
    installedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("storage:kv", () => {
  test("set then get round-trips a value scoped to the calling plugin", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await kv("plugin-a", { op: "set", key: "foo", value: { n: 1 } });
    const result = await kv("plugin-a", { op: "get", key: "foo" });

    expect(result).toEqual({ n: 1 });
  });

  test("a plugin cannot read another plugin's key, even with the same key name", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await kv("plugin-a", { op: "set", key: "shared-key", value: "a-secret" });
    const crossRead = await kv("plugin-b", { op: "get", key: "shared-key" });
    const ownRead = await kv("plugin-a", { op: "get", key: "shared-key" });

    expect(crossRead).toBeNull();
    expect(ownRead).toBe("a-secret");
  });

  test("get returns null for a missing key", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    const result = await kv("plugin-a", { op: "get", key: "missing" });
    expect(result).toBeNull();
  });

  test("list only returns the calling plugin's own keys", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await kv("plugin-a", { op: "set", key: "one", value: 1 });
    await kv("plugin-a", { op: "set", key: "two", value: 2 });
    await kv("plugin-b", { op: "set", key: "one", value: "not-a" });

    const listed = (await kv("plugin-a", { op: "list" })) as {
      items: Array<{ key: string; value: unknown }>;
      nextAfterKey?: string;
    };

    expect(listed.items.map((row) => row.key).sort()).toEqual(["one", "two"]);
    expect(listed.items.every((row) => row.value !== "not-a")).toBe(true);
    expect(listed.nextAfterKey).toBeUndefined();
  });

  test("list pages results, capped at 1000, with an afterKey cursor", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    const keys = Array.from(
      { length: 1005 },
      (_, i) => `key-${String(i).padStart(4, "0")}`,
    );
    for (const key of keys) {
      await kv("plugin-a", { op: "set", key, value: 1 });
    }

    const firstPage = (await kv("plugin-a", { op: "list" })) as {
      items: Array<{ key: string; value: unknown }>;
      nextAfterKey?: string;
    };
    expect(firstPage.items).toHaveLength(1000);
    expect(firstPage.nextAfterKey).toBe(firstPage.items.at(-1)?.key);

    const secondPage = (await kv("plugin-a", {
      op: "list",
      afterKey: firstPage.nextAfterKey,
    })) as {
      items: Array<{ key: string; value: unknown }>;
      nextAfterKey?: string;
    };
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextAfterKey).toBeUndefined();
  });

  test("rejects a key longer than 256 characters", async () => {
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await expect(
      kv("plugin-a", { op: "get", key: "k".repeat(257) }),
    ).rejects.toThrow();
  });

  test("rejects a value larger than 64 KiB serialized", async () => {
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await expect(
      kv("plugin-a", {
        op: "set",
        key: "big",
        value: "x".repeat(64 * 1024 + 1),
      }),
    ).rejects.toThrow();
  });

  test("accepts a value right at the 64 KiB boundary", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    // JSON-quoted, so the serialized size is the string length plus 2.
    const value = "x".repeat(64 * 1024 - 2);
    await expect(
      kv("plugin-a", { op: "set", key: "boundary", value }),
    ).resolves.toEqual({ ok: true });
  });

  test("set is a single atomic upsert: no select-then-branch, and a second set on the same key updates in place", async () => {
    kvStore = [];
    insertCalls = 0;
    updateCalls = 0;
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await kv("plugin-a", { op: "set", key: "counter", value: 1 });
    await kv("plugin-a", { op: "set", key: "counter", value: 2 });

    expect(await kv("plugin-a", { op: "get", key: "counter" })).toBe(2);
    // Every `set` — insert or update — goes through `insert().onConflictDoUpdate()`;
    // `db.update()` is never called directly by the handler.
    expect(updateCalls).toBe(0);
    expect(insertCalls).toBe(2);
    expect(kvStore.filter((row) => row.key === "counter")).toHaveLength(1);
  });

  test("delete removes only the calling plugin's row", async () => {
    kvStore = [];
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await kv("plugin-a", { op: "set", key: "foo", value: 1 });
    await kv("plugin-b", { op: "set", key: "foo", value: 2 });
    await kv("plugin-a", { op: "delete", key: "foo" });

    expect(await kv("plugin-a", { op: "get", key: "foo" })).toBeNull();
    expect(await kv("plugin-b", { op: "get", key: "foo" })).toBe(2);
  });

  test("rejects a malformed payload", async () => {
    const handlers = buildCapabilityHandlers(pluginRow());
    const kv = handlers["storage:kv"];
    if (!kv) {
      throw new Error("storage:kv handler missing");
    }

    await expect(kv("plugin-a", { op: "nonsense" })).rejects.toThrow();
  });
});

describe("net:fetch", () => {
  const originalFetch = globalThis.fetch;

  function withFetch(
    fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) {
    globalThis.fetch = fn as typeof globalThis.fetch;
  }

  function restoreFetch() {
    globalThis.fetch = originalFetch;
  }

  test("allows an exact netDomains match and returns status/headers/bodyText", async () => {
    dnsAddresses = {};
    withFetch(async (_input) => {
      return new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      const result = (await netFetch("plugin-a", {
        url: "https://api.linear.app/graphql",
      })) as {
        status: number;
        headers: Record<string, string>;
        bodyText: string;
      };

      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toBe("text/plain");
      expect(result.bodyText).toBe("hello");
    } finally {
      restoreFetch();
    }
  });

  test("rejects an evil subdomain of a granted domain", async () => {
    const handlers = buildCapabilityHandlers(pluginRow());
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://evil.api.linear.app/graphql" }),
    ).rejects.toThrow(/not in netDomains/);
  });

  test("rejects the parent domain of a granted subdomain", async () => {
    const handlers = buildCapabilityHandlers(pluginRow());
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://linear.app/graphql" }),
    ).rejects.toThrow(/not in netDomains/);
  });

  test("rejects a non-http(s) scheme", async () => {
    const handlers = buildCapabilityHandlers(
      pluginRow({
        manifest: manifest({ netDomains: ["linear.app"] }),
      }),
    );
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "file:///etc/passwd" }),
    ).rejects.toThrow(/not allowed/);
  });

  test("rejects an IP-literal host outright, even one that would resolve fine", async () => {
    const handlers = buildCapabilityHandlers(
      pluginRow({ manifest: manifest({ netDomains: ["93.184.216.34"] }) }),
    );
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://93.184.216.34/graphql" }),
    ).rejects.toThrow(/ip literal/i);
  });

  test("rejects an allowlisted hostname that resolves to a loopback address", async () => {
    dnsAddresses = {
      "api.linear.app": [{ address: "127.0.0.1", family: 4 }],
    };

    const handlers = buildCapabilityHandlers(pluginRow());
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://api.linear.app/graphql" }),
    ).rejects.toThrow(/non-public address/);

    dnsAddresses = {};
  });

  test("rejects an allowlisted hostname that resolves to a private (RFC1918) address", async () => {
    dnsAddresses = {
      "api.linear.app": [{ address: "10.0.5.9", family: 4 }],
    };

    const handlers = buildCapabilityHandlers(pluginRow());
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://api.linear.app/graphql" }),
    ).rejects.toThrow(/non-public address/);

    dnsAddresses = {};
  });

  test("rejects an allowlisted hostname that resolves to a link-local IPv6 address", async () => {
    dnsAddresses = {
      "api.linear.app": [{ address: "fe80::1", family: 6 }],
    };

    const handlers = buildCapabilityHandlers(pluginRow());
    const netFetch = handlers["net:fetch"];
    if (!netFetch) {
      throw new Error("net:fetch handler missing");
    }

    await expect(
      netFetch("plugin-a", { url: "https://api.linear.app/graphql" }),
    ).rejects.toThrow(/non-public address/);

    dnsAddresses = {};
  });

  test("follows a redirect to another allowlisted domain", async () => {
    dnsAddresses = {};
    withFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.linear.app/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.linear.app/end" },
        });
      }
      return new Response("redirected-body", { status: 200 });
    });

    try {
      const handlers = buildCapabilityHandlers(
        pluginRow({
          manifest: manifest({
            netDomains: ["api.linear.app", "cdn.linear.app"],
          }),
        }),
      );
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      const result = (await netFetch("plugin-a", {
        url: "https://api.linear.app/start",
      })) as { status: number; bodyText: string };

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe("redirected-body");
    } finally {
      restoreFetch();
    }
  });

  test("rejects a redirect to a domain that was never granted", async () => {
    dnsAddresses = {};
    withFetch(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/steal" },
      });
    });

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await expect(
        netFetch("plugin-a", { url: "https://api.linear.app/start" }),
      ).rejects.toThrow(/not in netDomains/);
    } finally {
      restoreFetch();
    }
  });

  test("rejects a redirect chain longer than 5 hops", async () => {
    dnsAddresses = {};
    let hop = 0;
    withFetch(async () => {
      hop++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://api.linear.app/hop-${hop}` },
      });
    });

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await expect(
        netFetch("plugin-a", { url: "https://api.linear.app/start" }),
      ).rejects.toThrow(/redirects/);
    } finally {
      restoreFetch();
    }
  });

  test("translates an aborted (timed-out) request into a clear error", async () => {
    dnsAddresses = {};
    withFetch(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await expect(
        netFetch("plugin-a", { url: "https://api.linear.app/graphql" }),
      ).rejects.toThrow(/timed out/);
    } finally {
      restoreFetch();
    }
  });

  test("truncates the response body to 1MB", async () => {
    dnsAddresses = {};
    const oversized = "x".repeat(1_000_000 + 500);
    withFetch(async () => new Response(oversized, { status: 200 }));

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      const result = (await netFetch("plugin-a", {
        url: "https://api.linear.app/graphql",
      })) as { bodyText: string };

      expect(result.bodyText.length).toBe(1_000_000);
    } finally {
      restoreFetch();
    }
  });

  test("pins the connection to the resolved address, ignoring whatever a later lookup would say", async () => {
    dnsAddresses = {
      "api.linear.app": [{ address: "203.0.113.5", family: 4 }],
    };
    agentConstructorCalls = [];
    let capturedDispatcher: unknown;
    withFetch(async (_input, init) => {
      capturedDispatcher = (init as { dispatcher?: unknown } | undefined)
        ?.dispatcher;
      return new Response("ok", { status: 200 });
    });

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await netFetch("plugin-a", { url: "https://api.linear.app/graphql" });

      expect(agentConstructorCalls).toHaveLength(1);
      expect(capturedDispatcher).toBeInstanceOf(FakeDispatcher);

      const lookup = agentConstructorCalls[0]?.connect?.lookup;
      if (!lookup) {
        throw new Error("Agent was not constructed with a connect.lookup");
      }

      // Even if undici's own connect logic asked to resolve a completely
      // different (attacker-controlled) hostname, or the DNS record changed
      // between the earlier check and now, the pinned lookup ignores the
      // hostname argument entirely and always answers with the address
      // `resolveValidatedAddress` already validated. That is what makes a
      // second, independent resolution — the DNS-rebind attack — impossible
      // here: there is no second resolution.
      const results: Array<[Error | null, string, number]> = [];
      lookup("evil.attacker.example", {}, (err, address, family) => {
        results.push([err, address, family]);
      });

      expect(results).toEqual([[null, "203.0.113.5", 4]]);
    } finally {
      restoreFetch();
      dnsAddresses = {};
    }
  });

  test("closes the pinned dispatcher after a successful fetch", async () => {
    dnsAddresses = {};
    agentCloseCalls = 0;
    withFetch(async () => new Response("ok", { status: 200 }));

    try {
      const handlers = buildCapabilityHandlers(pluginRow());
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await netFetch("plugin-a", { url: "https://api.linear.app/graphql" });

      expect(agentCloseCalls).toBe(1);
    } finally {
      restoreFetch();
    }
  });

  test("closes each hop's dispatcher when following a redirect, not just the final one", async () => {
    dnsAddresses = {};
    agentCloseCalls = 0;
    withFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.linear.app/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.linear.app/end" },
        });
      }
      return new Response("redirected-body", { status: 200 });
    });

    try {
      const handlers = buildCapabilityHandlers(
        pluginRow({
          manifest: manifest({
            netDomains: ["api.linear.app", "cdn.linear.app"],
          }),
        }),
      );
      const netFetch = handlers["net:fetch"];
      if (!netFetch) {
        throw new Error("net:fetch handler missing");
      }

      await netFetch("plugin-a", { url: "https://api.linear.app/start" });

      // One dispatcher for the redirect hop, one for the final response —
      // both closed: the first because its body is never read, the second
      // once `readBodyTextCapped` finishes with it.
      expect(agentCloseCalls).toBe(2);
    } finally {
      restoreFetch();
    }
  });
});

describe("messages:post", () => {
  test("calls submitChatMessage (the route's shared submit path) for an existing chat", async () => {
    chatRow = { sessionId: "session-1", activeStreamId: null };
    sessionRow = { id: "session-1", userId: "user-1", status: "running" };
    submitOutcome = {
      kind: "streaming",
      runId: "run-42",
      stream: new ReadableStream(),
    };
    submitChatMessageSpy.mockClear();

    const handlers = buildCapabilityHandlers(pluginRow());
    const messagesPost = handlers["messages:post"];
    if (!messagesPost) {
      throw new Error("messages:post handler missing");
    }

    const result = await messagesPost("my-plugin", {
      chatId: "chat-1",
      text: "hello from a plugin",
    });

    expect(result).toEqual({ ok: true, runId: "run-42" });
    expect(submitChatMessageSpy).toHaveBeenCalledTimes(1);
    const call = submitChatMessageSpy.mock.calls[0]?.[0] as {
      chatId: string;
      sessionId: string;
      userId: string;
      sessionStatus: string;
      activeStreamId: string | null;
      messages: Array<{ role: string }>;
    };
    expect(call.chatId).toBe("chat-1");
    expect(call.sessionId).toBe("session-1");
    expect(call.userId).toBe("user-1");
    expect(call.sessionStatus).toBe("running");
    expect(call.activeStreamId).toBeNull();
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]?.role).toBe("user");
  });

  test("attributes the posted message to the plugin via metadata.postedBy", async () => {
    chatRow = { sessionId: "session-1", activeStreamId: null };
    sessionRow = { id: "session-1", userId: "user-1", status: "running" };
    submitOutcome = {
      kind: "streaming",
      runId: "run-42",
      stream: new ReadableStream(),
    };
    submitChatMessageSpy.mockClear();

    const handlers = buildCapabilityHandlers(pluginRow());
    const messagesPost = handlers["messages:post"];
    if (!messagesPost) {
      throw new Error("messages:post handler missing");
    }

    await messagesPost("linear-sync", {
      chatId: "chat-1",
      text: "hello from a plugin",
    });

    const call = submitChatMessageSpy.mock.calls[0]?.[0] as {
      messages: Array<{
        metadata?: { postedBy?: { kind: "plugin"; pluginId: string } };
      }>;
    };
    expect(call.messages[0]?.metadata?.postedBy).toEqual({
      kind: "plugin",
      pluginId: "linear-sync",
    });
  });

  test("rejects a chatId with no backing chat", async () => {
    chatRow = undefined;
    sessionRow = undefined;
    submitChatMessageSpy.mockClear();

    const handlers = buildCapabilityHandlers(pluginRow());
    const messagesPost = handlers["messages:post"];
    if (!messagesPost) {
      throw new Error("messages:post handler missing");
    }

    await expect(
      messagesPost("my-plugin", { chatId: "does-not-exist", text: "hi" }),
    ).rejects.toThrow(/not found/);
    expect(submitChatMessageSpy).not.toHaveBeenCalled();
  });

  test("surfaces a conflicting active stream as a rejection", async () => {
    chatRow = { sessionId: "session-1", activeStreamId: "run-existing" };
    sessionRow = { id: "session-1", userId: "user-1", status: "running" };
    submitOutcome = { kind: "conflict" };

    const handlers = buildCapabilityHandlers(pluginRow());
    const messagesPost = handlers["messages:post"];
    if (!messagesPost) {
      throw new Error("messages:post handler missing");
    }

    await expect(
      messagesPost("my-plugin", { chatId: "chat-1", text: "hi" }),
    ).rejects.toThrow(/conflicting active stream/);
  });
});
