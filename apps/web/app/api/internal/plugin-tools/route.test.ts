import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const TEST_TOKEN = "test-plugin-tools-token";

mock.module("@/lib/plugins/tools-token", () => ({
  pluginToolsToken: () => TEST_TOKEN,
}));

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

function request(body: unknown, token: string | null = TEST_TOKEN): Request {
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
  test("rejects a missing or wrong bearer token", async () => {
    registry = new Map();
    ensureCalls = 0;

    const missing = await POST(
      request({ pluginId: "p", tool: "t", input: {} }, null),
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      request({ pluginId: "p", tool: "t", input: {} }, "nope"),
    );
    expect(wrong.status).toBe(401);

    // Never even reaches the registry when the token is wrong.
    expect(ensureCalls).toBe(0);
  });

  test("rejects a malformed body", async () => {
    registry = new Map();

    const response = await POST(request({ pluginId: "" }));
    expect(response.status).toBe(400);
  });

  test("404s for a plugin with no running host", async () => {
    registry = new Map();

    const response = await POST(
      request({ pluginId: "missing-plugin", tool: "echo", input: {} }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  test("invokes the tool on the plugin's host and returns its outcome", async () => {
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

    const response = await POST(
      request({
        pluginId: "demo-plugin",
        tool: "greet",
        input: { name: "ada" },
      }),
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

    const response = await POST(
      request({ pluginId: "demo-plugin", tool: "greet", input: {} }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "boom" });
  });
});
