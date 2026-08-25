import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// The route unseals `plugins.ingressSecret` with `lib/crypto/secret-box`,
// which derives its key from APP_SECRET — same fixture value
// `secret-box.test.ts` uses.
process.env.APP_SECRET ??= "test-secret-for-channel-ingress-route-000000";

type PluginRowStub = { id: string; ingressSecret: string | null };
let pluginRow: PluginRowStub | undefined;

mock.module("@/lib/db/plugins", () => ({
  getPlugin: (id: string) =>
    Promise.resolve(pluginRow && pluginRow.id === id ? pluginRow : undefined),
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
}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.secret !== null) {
    headers.set("x-paco-channel-secret", options.secret ?? CORRECT_SECRET);
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
        makeRequest({}),
        paramsFor("rate-limited-plugin", "events"),
      );
    }

    expect(last?.status).toBe(429);
  });
});
