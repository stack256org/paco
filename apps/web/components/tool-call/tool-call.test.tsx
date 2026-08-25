import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebAgentUIToolPart } from "@/app/types";
import type { PluginRendererInfo } from "@/app/lib/render-tool";
import { ToolCall } from "./tool-call";

function dynamicToolPart(toolName: string): WebAgentUIToolPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: "call-1",
    state: "output-available",
    input: { query: "hello" },
    output: { results: [] },
  } as WebAgentUIToolPart;
}

/**
 * The name a plugin tool ACTUALLY reaches dispatch with.
 *
 * Claude Code prefixes every MCP tool `mcp__<server>__<tool>`, the server
 * here is the one aggregate "paco-plugins" bridge, and the bridge's own
 * tool name is `<pluginId>__<tool>` — so nothing bare ever arrives. These
 * tests used to hand `ToolCall` bare names, which is why they passed while
 * no plugin renderer had ever matched a real tool call in production.
 */
function pluginToolName(pluginId: string, tool: string): string {
  return `mcp__paco-plugins__${pluginId}__${tool}`;
}

describe("ToolCall dispatch to plugin renderers", () => {
  test("routes a real MCP-prefixed plugin tool call to PluginRenderer", () => {
    const pluginRenderers: PluginRendererInfo[] = [
      { pluginId: "docs-plugin", toolNames: ["search_docs"] },
    ];

    const html = renderToStaticMarkup(
      <ToolCall
        part={dynamicToolPart(pluginToolName("docs-plugin", "search_docs"))}
        pluginRenderers={pluginRenderers}
      />,
    );

    // PluginRenderer's iframe, pointed at this plugin's renderer route —
    // named by the bare renderer file, not the prefixed tool name.
    expect(html).toContain(
      'src="/api/plugins/renderer/docs-plugin/search_docs.html"',
    );
    expect(html).toContain('sandbox="allow-scripts"');
  });

  test("falls back to the existing generic renderer for a tool no plugin registered", () => {
    const pluginRenderers: PluginRendererInfo[] = [
      { pluginId: "docs-plugin", toolNames: ["search_docs"] },
    ];

    const html = renderToStaticMarkup(
      <ToolCall
        part={dynamicToolPart(
          pluginToolName("docs-plugin", "some_unknown_tool"),
        )}
        pluginRenderers={pluginRenderers}
      />,
    );

    expect(html).not.toContain("<iframe");
  });

  test("falls back to the generic renderer for a bare tool name a plugin happens to share", () => {
    const pluginRenderers: PluginRendererInfo[] = [
      { pluginId: "docs-plugin", toolNames: ["search_docs"] },
    ];

    const html = renderToStaticMarkup(
      <ToolCall
        part={dynamicToolPart("search_docs")}
        pluginRenderers={pluginRenderers}
      />,
    );

    expect(html).not.toContain("<iframe");
    expect(html).toContain("Search_docs");
  });

  test("falls back to the existing generic renderer when no plugin renderers are passed at all", () => {
    const html = renderToStaticMarkup(
      <ToolCall
        part={dynamicToolPart(pluginToolName("docs-plugin", "search_docs"))}
      />,
    );

    expect(html).not.toContain("<iframe");
  });
});
