import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, mock, test } from "bun:test";
import type { PluginManifest } from "@paco/plugin-kit";
import type { EnabledPluginForMcp } from "./mcp-bridge.ts";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

// `buildPluginMcpConfig` mints a real, signed token (`tools-token.ts`), which
// derives its key from `APP_SECRET` — same fixture value convention as
// `lib/crypto/secret-box.test.ts` and `lib/preview/preview-grant.test.ts`.
process.env.APP_SECRET ??= "test-secret-for-mcp-bridge-00000000000000000";

const { buildPluginMcpConfig, PLUGIN_MCP_SERVER_SOURCE } =
  await import("./mcp-bridge.ts");
const { verifyPluginToolsToken } = await import("./tools-token.ts");

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "demo-plugin",
    version: "1.0.0",
    description: "a demo plugin",
    pacoApi: 1,
    capabilities: ["tools:register"],
    ...overrides,
  };
}

const OPTS = {
  internalUrl: "http://127.0.0.1:3000/api/internal/plugin-tools",
};

describe("PLUGIN_MCP_SERVER_SOURCE", () => {
  test("matches scripts/plugin-mcp-server.ts byte for byte", () => {
    const onDisk = readFileSync(
      new URL("../../scripts/plugin-mcp-server.ts", import.meta.url),
      "utf-8",
    );
    expect(PLUGIN_MCP_SERVER_SOURCE).toBe(onDisk);
  });
});

describe("the standalone MCP server scrubs its environment", () => {
  test("keeps only the three documented PACO_* variables, deleting everything else it inherited", async () => {
    const scriptPath = new URL(
      "../../scripts/plugin-mcp-server.ts",
      import.meta.url,
    );

    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(scriptPath)], {
        env: {
          // Ambient secrets a real deployment would have set on the Next.js
          // process, and that `run.ts` (`{...process.env, ...options.env}`)
          // hands to the CLI, which is the leak this scrub guards against.
          APP_SECRET: "super-secret",
          POSTGRES_URL: "postgres://leaked",
          SMTP_PASSWORD: "hunter2",
          PATH: process.env.PATH ?? "",
          // Present only to prove the scrub removes it too — the script
          // itself never reads it.
          NODE_ENV: process.env.NODE_ENV ?? "test",
          PACO_INTERNAL_URL: "http://127.0.0.1:1/api/internal/plugin-tools",
          PACO_INTERNAL_TOKEN: "tok-abc",
          PACO_PLUGIN_TOOLS: "[]",
        },
      }) as ChildProcessWithoutNullStreams;

      let stderrBuffer = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf-8");
      });
      child.on("error", reject);
      child.stdin.end();
      child.on("close", () => resolve(stderrBuffer));
    });

    const match = stderr.match(/keys retained: (.*)/);
    expect(match).not.toBeNull();
    const retained = (match?.[1] ?? "").trim().split(",").filter(Boolean);

    expect(retained.sort()).toEqual([
      "PACO_INTERNAL_TOKEN",
      "PACO_INTERNAL_URL",
      "PACO_PLUGIN_TOOLS",
    ]);
    expect(retained).not.toContain("APP_SECRET");
    expect(retained).not.toContain("POSTGRES_URL");
    expect(retained).not.toContain("SMTP_PASSWORD");
    expect(retained).not.toContain("PATH");
    expect(retained).not.toContain("NODE_ENV");
  });
});

describe("buildPluginMcpConfig", () => {
  test("returns an empty config for no enabled plugins", () => {
    expect(buildPluginMcpConfig([], OPTS)).toEqual({});
  });

  test("returns an empty config for a plugin with no tools and no manifest mcpServers", () => {
    const enabled: EnabledPluginForMcp[] = [
      { id: "demo-plugin", manifest: manifest(), tools: [] },
    ];
    expect(buildPluginMcpConfig(enabled, OPTS)).toEqual({});
  });

  test("aggregates every enabled plugin's tools behind one paco-plugins server", () => {
    const enabled: EnabledPluginForMcp[] = [
      {
        id: "demo-plugin",
        manifest: manifest(),
        tools: [
          {
            name: "echo",
            description: "echoes input",
            inputSchema: { type: "object" },
          },
        ],
      },
      {
        id: "other-plugin",
        manifest: manifest({ name: "other-plugin" }),
        tools: [
          {
            name: "greet",
            description: "greets",
            inputSchema: { type: "object" },
          },
        ],
      },
    ];

    const config = buildPluginMcpConfig(enabled, OPTS);
    const server = config["paco-plugins"];
    expect(server).toBeDefined();
    expect(server?.command).toBe(process.execPath);
    expect(server?.args).toHaveLength(1);
    expect(server?.args[0]).toMatch(/plugin-mcp-server\.ts$/);
    expect(server?.env.PACO_INTERNAL_URL).toBe(OPTS.internalUrl);

    // Scoped to exactly the two plugins that contributed tools: valid for
    // either of them, out-of-scope for anything else.
    const token = server?.env.PACO_INTERNAL_TOKEN ?? "";
    expect(verifyPluginToolsToken(token, "demo-plugin")).toEqual({ ok: true });
    expect(verifyPluginToolsToken(token, "other-plugin")).toEqual({
      ok: true,
    });
    expect(verifyPluginToolsToken(token, "some-unrelated-plugin")).toEqual({
      ok: false,
      reason: "out-of-scope",
    });

    const tools = JSON.parse(server?.env.PACO_PLUGIN_TOOLS ?? "[]");
    expect(tools).toEqual([
      {
        pluginId: "demo-plugin",
        name: "echo",
        description: "echoes input",
        inputSchema: { type: "object" },
      },
      {
        pluginId: "other-plugin",
        name: "greet",
        description: "greets",
        inputSchema: { type: "object" },
      },
    ]);

    // The bridge script actually lands on disk where `args[0]` points, and
    // its content is exactly the embedded source — proof the config points
    // at something runnable, not a dangling path.
    const written = readFileSync(server?.args[0] as string, "utf-8");
    expect(written).toBe(PLUGIN_MCP_SERVER_SOURCE);
  });

  test("excludes a tool-less enabled plugin from the token's scope", () => {
    const enabled: EnabledPluginForMcp[] = [
      {
        id: "demo-plugin",
        manifest: manifest(),
        tools: [
          {
            name: "echo",
            description: "echoes input",
            inputSchema: { type: "object" },
          },
        ],
      },
      // Enabled and passed in, but contributes no registered tools — it has
      // nothing this bridge could ever invoke, so it must not be in scope.
      {
        id: "toolless-plugin",
        manifest: manifest({ name: "toolless-plugin" }),
        tools: [],
      },
    ];

    const config = buildPluginMcpConfig(enabled, OPTS);
    const token = config["paco-plugins"]?.env.PACO_INTERNAL_TOKEN ?? "";

    expect(verifyPluginToolsToken(token, "demo-plugin")).toEqual({ ok: true });
    expect(verifyPluginToolsToken(token, "toolless-plugin")).toEqual({
      ok: false,
      reason: "out-of-scope",
    });
  });

  test("passes a plugin's manifest mcpServers through, namespaced by plugin id", () => {
    const enabled: EnabledPluginForMcp[] = [
      {
        id: "demo-plugin",
        manifest: manifest({
          mcpServers: {
            search: {
              command: "npx",
              args: ["-y", "some-mcp-server"],
              env: { API_KEY: "shh" },
            },
          },
        }),
        tools: [],
      },
    ];

    const config = buildPluginMcpConfig(enabled, OPTS);
    expect(config["demo-plugin-search"]).toEqual({
      command: "npx",
      args: ["-y", "some-mcp-server"],
      env: { API_KEY: "shh" },
    });
    // A plugin with only a passthrough MCP server and no registered tools
    // does not get an aggregate "paco-plugins" entry.
    expect(config["paco-plugins"]).toBeUndefined();
  });

  test("namespaces two plugins' same-named mcpServers entry separately", () => {
    const enabled: EnabledPluginForMcp[] = [
      {
        id: "plugin-a",
        manifest: manifest({
          name: "plugin-a",
          mcpServers: { search: { command: "cmd-a", args: [], env: {} } },
        }),
        tools: [],
      },
      {
        id: "plugin-b",
        manifest: manifest({
          name: "plugin-b",
          mcpServers: { search: { command: "cmd-b", args: [], env: {} } },
        }),
        tools: [],
      },
    ];

    const config = buildPluginMcpConfig(enabled, OPTS);
    expect(config["plugin-a-search"]?.command).toBe("cmd-a");
    expect(config["plugin-b-search"]?.command).toBe("cmd-b");
  });
});
