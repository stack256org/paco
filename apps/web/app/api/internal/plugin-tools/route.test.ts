import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

// The route's auth now goes through a real, signed, scoped token
// (`lib/plugins/tools-token.ts`, derived from `APP_SECRET`) rather than a
// mocked shared secret — same fixture convention as
// `lib/crypto/secret-box.test.ts`.
process.env.APP_SECRET ??= "test-secret-for-plugin-tools-route-0000000000";

let ensureCalls = 0;
type StubHost = {
  invokeTool: (tool: string, input: unknown) => Promise<unknown>;
};
let registry: Map<string, StubHost>;

mock.module("@/lib/plugins/registry", () => ({
  ensurePluginsStarted: async () => {
    ensureCalls++;
  },
  getPluginRegistry: () => registry,
}));

const { POST } = await import("./route");
const { mintPluginToolsToken } = await import("@/lib/plugins/tools-token");

function request(body: unknown, token: string | null): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return new Request("http://localhost/api/internal/plugin-tools", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/plugin-tools", () => {
  test("rejects a missing bearer token", async () => {
    registry = new Map();
    ensureCalls = 0;

    const response = await POST(
      request({ pluginId: "demo-plugin", tool: "t", input: {} }, null),
    );

    expect(response.status).toBe(401);
    // Never even reaches the registry when the token is missing.
    expect(ensureCalls).toBe(0);
  });

  test("rejects a tampered token", async () => {
    registry = new Map();
    const token = mintPluginToolsToken(["demo-plugin"]);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    const response = await POST(
      request({ pluginId: "demo-plugin", tool: "t", input: {} }, tampered),
    );

    expect(response.status).toBe(401);
  });

  test("rejects an expired token", async () => {
    registry = new Map();
    const token = mintPluginToolsToken(["demo-plugin"]);

    const realNow = Date.now;
    Date.now = () => realNow() + 7 * 60 * 60 * 1000; // past the 6h TTL
    try {
      const response = await POST(
        request({ pluginId: "demo-plugin", tool: "t", input: {} }, token),
      );
      expect(response.status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  test("rejects a valid token used for a plugin outside its scope", async () => {
    registry = new Map();
    const token = mintPluginToolsToken(["demo-plugin"]);

    const response = await POST(
      request({ pluginId: "some-other-plugin", tool: "t", input: {} }, token),
    );

    expect(response.status).toBe(403);
  });

  test("rejects a malformed body before ever checking the token", async () => {
    registry = new Map();

    const response = await POST(request({ pluginId: "" }, null));
    expect(response.status).toBe(400);
  });

  test("404s for a plugin with no running host", async () => {
    registry = new Map();
    const token = mintPluginToolsToken(["missing-plugin"]);

    const response = await POST(
      request({ pluginId: "missing-plugin", tool: "echo", input: {} }, token),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  test("valid token + in-scope plugin: invokes the tool and returns its outcome", async () => {
    let calledWith: { tool: string; input: unknown } | undefined;
    registry = new Map([
      [
        "demo-plugin",
        {
          invokeTool: async (tool: string, input: unknown) => {
            calledWith = { tool, input };
            return { ok: true, output: { greeting: "hi" } };
          },
        },
      ],
    ]);
    const token = mintPluginToolsToken(["demo-plugin"]);

    const response = await POST(
      request(
        { pluginId: "demo-plugin", tool: "greet", input: { name: "ada" } },
        token,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      output: { greeting: "hi" },
    });
    expect(calledWith).toEqual({ tool: "greet", input: { name: "ada" } });
    expect(ensureCalls).toBeGreaterThan(0);
  });

  test("passes a failed tool outcome straight through", async () => {
    registry = new Map([
      [
        "demo-plugin",
        {
          invokeTool: async () => ({ ok: false, error: "boom" }),
        },
      ],
    ]);
    const token = mintPluginToolsToken(["demo-plugin"]);

    const response = await POST(
      request({ pluginId: "demo-plugin", tool: "greet", input: {} }, token),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "boom" });
  });

  test("a token scoped to multiple plugins works for each of them", async () => {
    registry = new Map([
      ["plugin-a", { invokeTool: async () => ({ ok: true, output: "a" }) }],
      ["plugin-b", { invokeTool: async () => ({ ok: true, output: "b" }) }],
    ]);
    const token = mintPluginToolsToken(["plugin-a", "plugin-b"]);

    const responseA = await POST(
      request({ pluginId: "plugin-a", tool: "t", input: {} }, token),
    );
    const responseB = await POST(
      request({ pluginId: "plugin-b", tool: "t", input: {} }, token),
    );

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
  });
});
