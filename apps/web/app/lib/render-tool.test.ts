import { describe, expect, test } from "bun:test";
import { resolvePluginRenderer } from "./render-tool";

describe("resolvePluginRenderer", () => {
  test("matches the MCP-prefixed name a plugin tool call actually arrives with", () => {
    const match = resolvePluginRenderer(
      "mcp__paco-plugins__docs-plugin__search_docs",
      [{ pluginId: "docs-plugin", toolNames: ["search_docs", "fetch_doc"] }],
    );

    expect(match).toEqual({
      pluginId: "docs-plugin",
      file: "search_docs.html",
    });
  });

  test("returns undefined when no plugin registered a renderer for the tool name", () => {
    const match = resolvePluginRenderer(
      "mcp__paco-plugins__docs-plugin__bash",
      [{ pluginId: "docs-plugin", toolNames: ["search_docs"] }],
    );

    expect(match).toBeUndefined();
  });

  test("returns undefined given an empty plugin list", () => {
    expect(
      resolvePluginRenderer("mcp__paco-plugins__any-plugin__anything", []),
    ).toBeUndefined();
  });

  test("does not match a bare tool name that carries no plugin prefix", () => {
    // A plugin tool NEVER arrives bare; a same-named tool from some other MCP
    // server, or a built-in, would — and it is not this plugin's to render.
    expect(
      resolvePluginRenderer("search_docs", [
        { pluginId: "docs-plugin", toolNames: ["search_docs"] },
      ]),
    ).toBeUndefined();
  });

  test("does not match a renderer registered by a DIFFERENT plugin", () => {
    // The prefix names the plugin the call was routed to. A second plugin
    // registering the same tool name must not steal its rendering.
    expect(
      resolvePluginRenderer("mcp__paco-plugins__other-plugin__search_docs", [
        { pluginId: "docs-plugin", toolNames: ["search_docs"] },
      ]),
    ).toBeUndefined();
  });

  test("picks the plugin the prefix names when more than one registers the same tool name", () => {
    const match = resolvePluginRenderer(
      "mcp__paco-plugins__second-plugin__shared_tool",
      [
        { pluginId: "first-plugin", toolNames: ["shared_tool"] },
        { pluginId: "second-plugin", toolNames: ["shared_tool"] },
      ],
    );

    expect(match?.pluginId).toBe("second-plugin");
  });

  test("matches a tool name that itself contains the __ separator", () => {
    // Splitting on the first `__` after the prefix would read the plugin id
    // as "docs-plugin" and the tool as "search__docs" only by luck; matching
    // against each registered (pluginId, toolName) pair is exact.
    const match = resolvePluginRenderer(
      "mcp__paco-plugins__docs-plugin__search__docs",
      [{ pluginId: "docs-plugin", toolNames: ["search__docs"] }],
    );

    expect(match).toEqual({
      pluginId: "docs-plugin",
      file: "search__docs.html",
    });
  });

  test("ignores a name from some other MCP server entirely", () => {
    expect(
      resolvePluginRenderer("mcp__github__search_docs", [
        { pluginId: "docs-plugin", toolNames: ["search_docs"] },
      ]),
    ).toBeUndefined();
  });
});
