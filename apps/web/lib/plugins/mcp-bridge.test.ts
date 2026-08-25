import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";
import type { PluginManifest } from "@paco/plugin-kit";
import type { EnabledPluginForMcp } from "./mcp-bridge.ts";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

const { buildPluginMcpConfig, PLUGIN_MCP_SERVER_SOURCE } =
  await import("./mcp-bridge.ts");

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
  token: "tok-abc",
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
    expect(server?.env.PACO_INTERNAL_TOKEN).toBe(OPTS.token);

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
