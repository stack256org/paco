import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// The route unseals `plugins.ingressSecret` with `lib/crypto/secret-box`,
// which derives its key from APP_SECRET — same fixture value
// `secret-box.test.ts` uses.
process.env.APP_SECRET ??= "test-secret-for-channel-ingress-route-000000";

type PluginRowStub = {
  id: string;
  ingressSecret: string | null;
  /**
   * Only set by the tests that care which auth gate applies. Omitting it
   * stands for the common case — a manifest declaring no channel auth modes
   * at all — which `channelAuthMode` reads as `"shared-secret"`.
   */
  manifest?: {
    channels?: { name: string; auth: "shared-secret" | "self-verified" }[];
  };
};
let pluginRow: PluginRowStub | undefined;

mock.module("@/lib/db/plugins", () => ({
  getPlugin: (id: string) =>
    Promise.resolve(
      pluginRow && pluginRow.id === id
        ? { ...pluginRow, manifest: pluginRow.manifest ?? {} }
        : undefined,
    ),
}));

type IngressOutcomeStub =
  | { ok: true; status: number; body?: unknown }
  | {
      ok: false;
      reason: "not-granted" | "not-running" | "timeout";
      error: string;
    };
type HostStub = {
  state: string;
  deliverIngress: (
    channel: string,
    headers: Record<string, string>,
    body: unknown,
    rawBody: string,
  ) => Promise<IngressOutcomeStub>;
};
let registry: Map<string, HostStub>;

mock.module("@/lib/plugins/registry", () => ({
  getPluginRegistry: () => registry,
}));

const { POST } = await import("./route");
const { seal } = await import("@/lib/crypto/secret-box");

const CORRECT_SECRET = "correct-secret-value";

function makeRequest(options: {
  secret?: string | null;
  body?: string;
  /** The real source IP, as nginx would report it. */
  ip?: string;
  /** A client-supplied X-Forwarded-For value, prepended the way nginx does. */
  forgedPrefix?: string;
  /** Set false to simulate a proxy that sent no X-Real-IP. */
  realIp?: false;
}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.secret !== null) {
    headers.set("x-paco-channel-secret", options.secret ?? CORRECT_SECRET);
  }
  if (options.ip) {
    // Mirrors nginx's `$proxy_add_x_forwarded_for`: whatever the client sent
    // stays at the FRONT and nginx appends the real peer at the BACK. Tests
    // that pass `forgedPrefix` are simulating a caller who supplied their own
    // X-Forwarded-For, which is what makes the first entry untrustworthy.
    headers.set(
      "x-forwarded-for",
      options.forgedPrefix
        ? `${options.forgedPrefix}, ${options.ip}`
        : options.ip,
    );
    if (options.realIp !== false) {
      // nginx sets this as a REPLACE, so it always reflects the real peer.
      headers.set("x-real-ip", options.ip);
    }
  }
  // The route reads pluginId/channel exclusively from `params`, never from
  // the URL, so every test can share one URL and vary only what matters.
  return new Request("http://localhost/api/channels/plugin/channel", {
    method: "POST",
    headers,
    body: options.body ?? '{"hello":"world"}',
  });
}

function paramsFor(pluginId: string, channel: string) {
  return { params: Promise.resolve({ pluginId, channel }) };
}

describe("POST /api/channels/[pluginId]/[channel]", () => {
  test("404s for a malformed plugin id or channel, before any lookup", async () => {
    pluginRow = undefined;
    registry = new Map();

    const response = await POST(
      makeRequest({}),
      paramsFor("Not Valid!", "events"),
    );

    expect(response.status).toBe(404);
  });

  test("404s for an unknown plugin", async () => {
    pluginRow = undefined;
    registry = new Map();

    const response = await POST(
      makeRequest({}),
      paramsFor("unknown-plugin", "events"),
    );

    expect(response.status).toBe(404);
  });

  test("401s for a missing secret header", async () => {
    pluginRow = { id: "auth-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: null }),
      paramsFor("auth-plugin", "events"),
    );

    expect(response.status).toBe(401);
  });

  test("401s for a wrong secret", async () => {
    pluginRow = { id: "auth-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: "totally-wrong" }),
      paramsFor("auth-plugin", "events"),
    );

    expect(response.status).toBe(401);
  });

  test("401s when the plugin has never had an ingress secret generated", async () => {
    pluginRow = { id: "auth-plugin", ingressSecret: null };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: "anything" }),
      paramsFor("auth-plugin", "events"),
    );

    expect(response.status).toBe(401);
  });

  test("401s for a corrupted sealed secret, without 500ing", async () => {
    pluginRow = { id: "auth-plugin", ingressSecret: "not-a-sealed-value" };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: "anything" }),
      paramsFor("auth-plugin", "events"),
    );

    expect(response.status).toBe(401);
  });

  test('a "self-verified" channel is delivered with no secret header at all', async () => {
    // The reason this mode exists: Slack's Event Subscriptions UI takes a
    // Request URL and nothing else, so the shared-secret header can never
    // arrive. The handler verifies the signature itself instead.
    pluginRow = {
      id: "slack",
      ingressSecret: seal(CORRECT_SECRET),
      manifest: { channels: [{ name: "events", auth: "self-verified" }] },
    };
    let seenHeaders: Record<string, string> | undefined;
    registry = new Map([
      [
        "slack",
        {
          state: "running",
          deliverIngress: (
            _channel: string,
            headers: Record<string, string>,
          ) => {
            seenHeaders = headers;
            return Promise.resolve({ ok: true as const, status: 200 });
          },
        },
      ],
    ]);

    const response = await POST(
      makeRequest({ secret: null }),
      paramsFor("slack", "events"),
    );

    expect(response.status).toBe(200);
    // The handler cannot verify a Slack signature without these.
    expect(seenHeaders?.["content-type"]).toBe("application/json");
  });

  test('a "self-verified" declaration applies only to the channel it names', async () => {
    pluginRow = {
      id: "slack",
      ingressSecret: seal(CORRECT_SECRET),
      manifest: { channels: [{ name: "events", auth: "self-verified" }] },
    };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: null }),
      paramsFor("slack", "commands"),
    );

    // "commands" is undeclared, so it keeps the shared-secret default and a
    // missing header is still a 401 — not the 503 a delivered request would
    // have produced against this empty registry.
    expect(response.status).toBe(401);
  });

  test('a "shared-secret" declaration behaves exactly like no declaration', async () => {
    pluginRow = {
      id: "explicit",
      ingressSecret: seal(CORRECT_SECRET),
      manifest: { channels: [{ name: "events", auth: "shared-secret" }] },
    };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: "wrong" }),
      paramsFor("explicit", "events"),
    );

    expect(response.status).toBe(401);
  });

  test('a "self-verified" channel still gets the grant and running checks', async () => {
    // Skipping the secret must not skip anything else: an operator who never
    // granted channels:ingress, or a plugin that is down, answers the same
    // way it would for a shared-secret channel.
    pluginRow = {
      id: "slack",
      ingressSecret: null,
      manifest: { channels: [{ name: "events", auth: "self-verified" }] },
    };
    registry = new Map();

    const response = await POST(
      makeRequest({ secret: null }),
      paramsFor("slack", "events"),
    );

    expect(response.status).toBe(503);
  });

  test("503s when the plugin has no host in the registry", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map();

    const response = await POST(
      makeRequest({}),
      paramsFor("running-plugin", "events"),
    );

    expect(response.status).toBe(503);
  });

  test("503s when the host is registered but not in the running state", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map([
      [
        "running-plugin",
        {
          state: "crashed",
          deliverIngress: () => {
            throw new Error("must not be called for a non-running host");
          },
        },
      ],
    ]);

    const response = await POST(
      makeRequest({}),
      paramsFor("running-plugin", "events"),
    );

    expect(response.status).toBe(503);
  });

  test("happy path: mirrors {status, body} and forwards the exact raw body plus headers", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    let seenArgs: unknown[] = [];
    registry = new Map([
      [
        "running-plugin",
        {
          state: "running",
          deliverIngress: (channel, headers, body, rawBody) => {
            seenArgs = [channel, headers, body, rawBody];
            return Promise.resolve({
              ok: true,
              status: 201,
              body: { created: true },
            });
          },
        },
      ],
    ]);

    const response = await POST(
      makeRequest({ body: '{"a":1}' }),
      paramsFor("running-plugin", "events"),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
    expect(seenArgs[0]).toBe("events");
    expect(seenArgs[2]).toEqual({ a: 1 });
    expect(seenArgs[3]).toBe('{"a":1}');
    expect(
      (seenArgs[1] as Record<string, string>)["x-paco-channel-secret"],
    ).toBe(CORRECT_SECRET);
  });

  test("mirrors a non-JSON raw body as an undefined parsed body, unchanged raw bytes", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    let seenArgs: unknown[] = [];
    registry = new Map([
      [
        "running-plugin",
        {
          state: "running",
          deliverIngress: (channel, headers, body, rawBody) => {
            seenArgs = [channel, headers, body, rawBody];
            return Promise.resolve({ ok: true, status: 200, body: {} });
          },
        },
      ],
    ]);

    await POST(
      makeRequest({ body: "not json at all" }),
      paramsFor("running-plugin", "events"),
    );

    expect(seenArgs[2]).toBeUndefined();
    expect(seenArgs[3]).toBe("not json at all");
  });

  test("maps a timeout outcome to 504", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map([
      [
        "running-plugin",
        {
          state: "running",
          deliverIngress: () =>
            Promise.resolve({
              ok: false,
              reason: "timeout",
              error: "timed out",
            }),
        },
      ],
    ]);

    const response = await POST(
      makeRequest({}),
      paramsFor("running-plugin", "events"),
    );

    expect(response.status).toBe(504);
  });

  test("maps a not-granted outcome to 503", async () => {
    pluginRow = { id: "running-plugin", ingressSecret: seal(CORRECT_SECRET) };
    registry = new Map([
      [
        "running-plugin",
        {
          state: "running",
          deliverIngress: () =>
            Promise.resolve({
              ok: false,
              reason: "not-granted",
              error: "capability not granted",
            }),
        },
      ],
    ]);

    const response = await POST(
      makeRequest({}),
      paramsFor("running-plugin", "events"),
    );

    expect(response.status).toBe(503);
  });

  test("rate-limits repeated requests to the same plugin+channel", async () => {
    pluginRow = undefined;
    registry = new Map();

    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await POST(
        makeRequest({ ip: "203.0.113.10" }),
        paramsFor("rate-limited-plugin", "events"),
      );
    }

    expect(last?.status).toBe(429);
  });

  test("a caller cannot pick their own rate-limit bucket by forging X-Forwarded-For", async () => {
    // nginx APPENDS to X-Forwarded-For, so a client-supplied value survives at
    // the front. Reading the first entry let a caller rotate a forged value per
    // request and never accumulate against any bucket. The real peer is the
    // LAST entry (and X-Real-IP, which nginx replaces).
    pluginRow = undefined;
    registry = new Map();

    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await POST(
        // Same real peer every time; a different forged value each time.
        makeRequest({
          ip: "203.0.113.30",
          forgedPrefix: `10.0.0.${i}`,
          realIp: false,
        }),
        paramsFor("forge-plugin", "events"),
      );
    }

    // The forged prefixes must not have bought 61 fresh buckets.
    expect(last?.status).toBe(429);
  });

  test("a forged X-Forwarded-For cannot land in the real sender's bucket", async () => {
    // The other half of the same attack: forging the legitimate integration's
    // IP to burn ITS bucket and get its deliveries 429'd.
    pluginRow = undefined;
    registry = new Map();

    let attackerLast: Response | undefined;
    for (let i = 0; i < 61; i++) {
      attackerLast = await POST(
        makeRequest({
          ip: "203.0.113.31",
          forgedPrefix: "203.0.113.40",
          realIp: false,
        }),
        paramsFor("victim-plugin", "events"),
      );
    }
    expect(attackerLast?.status).toBe(429);

    // The IP the attacker was impersonating is still free to send.
    const legitimate = await POST(
      makeRequest({ ip: "203.0.113.40", realIp: false }),
      paramsFor("victim-plugin", "events"),
    );
    expect(legitimate.status).not.toBe(429);
  });

  test("X-Real-IP wins over X-Forwarded-For, since nginx replaces it", async () => {
    pluginRow = undefined;
    registry = new Map();

    const headers = new Headers({ "content-type": "application/json" });
    headers.set("x-real-ip", "203.0.113.50");
    headers.set("x-forwarded-for", "203.0.113.99, 203.0.113.50");
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await POST(
        new Request("http://localhost/api/channels/plugin/channel", {
          method: "POST",
          headers,
          body: "{}",
        }),
        paramsFor("realip-plugin", "events"),
      );
    }
    expect(last?.status).toBe(429);

    // The forged X-Forwarded-For front entry never got its own budget.
    const forgedIdentity = await POST(
      makeRequest({ ip: "203.0.113.99", realIp: false }),
      paramsFor("realip-plugin", "events"),
    );
    expect(forgedIdentity.status).not.toBe(429);
  });

  test("two different source IPs hammering the same plugin+channel do not starve each other", async () => {
    pluginRow = undefined;
    registry = new Map();

    // An attacker at one IP burns the (plugin, channel) bucket...
    let attackerLast: Response | undefined;
    for (let i = 0; i < 61; i++) {
      attackerLast = await POST(
        makeRequest({ ip: "203.0.113.20" }),
        paramsFor("shared-plugin", "events"),
      );
    }
    expect(attackerLast?.status).toBe(429);

    // ...but a different source IP hitting the exact same plugin+channel is
    // unaffected — it still reaches the (mocked) unknown-plugin 404, not a
    // 429 inherited from the attacker's bucket.
    const legitimate = await POST(
      makeRequest({ ip: "203.0.113.21" }),
      paramsFor("shared-plugin", "events"),
    );
    expect(legitimate.status).not.toBe(429);
  });

  test("one source IP is bounded in aggregate across many enumerated plugin ids", async () => {
    pluginRow = undefined;
    registry = new Map();
    const ip = "203.0.113.30";

    let last: Response | undefined;
    for (let i = 0; i < 301; i++) {
      // A distinct plugin id on every call, so the per-(plugin, channel, IP)
      // bucket (limit 60) never trips — only the per-IP bucket (limit 300),
      // across every id this source has tried, can explain a 429 here.
      last = await POST(
        makeRequest({ ip }),
        paramsFor(`enumerated-plugin-${i}`, "events"),
      );
    }

    expect(last?.status).toBe(429);
  });

  test("413s a body larger than the cap, without reaching the worker", async () => {
    pluginRow = {
      id: "big-body-plugin",
      ingressSecret: seal(CORRECT_SECRET),
    };
    let deliverCalled = false;
    registry = new Map([
      [
        "big-body-plugin",
        {
          state: "running",
          deliverIngress: () => {
            deliverCalled = true;
            return Promise.resolve({ ok: true, status: 200, body: {} });
          },
        },
      ],
    ]);

    const oversizedBody = "x".repeat(1_048_577);
    const response = await POST(
      makeRequest({ body: oversizedBody, ip: "203.0.113.40" }),
      paramsFor("big-body-plugin", "events"),
    );

    expect(response.status).toBe(413);
    expect(deliverCalled).toBe(false);
  });
});
