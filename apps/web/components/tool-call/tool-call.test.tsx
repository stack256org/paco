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

describe("ToolCall dispatch to plugin renderers", () => {
  test("routes a tool whose name matches an enabled plugin's renderer to PluginRenderer", () => {
    const pluginRenderers: PluginRendererInfo[] = [
      { pluginId: "docs-plugin", toolNames: ["search_docs"] },
    ];

    const html = renderToStaticMarkup(
      <ToolCall
        part={dynamicToolPart("search_docs")}
        pluginRenderers={pluginRenderers}
      />,
    );

    // PluginRenderer's iframe, pointed at this plugin's renderer route.
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
        part={dynamicToolPart("some_unknown_tool")}
        pluginRenderers={pluginRenderers}
      />,
    );

    expect(html).not.toContain("<iframe");
    expect(html).toContain("Some_unknown_tool");
  });

  test("falls back to the existing generic renderer when no plugin renderers are passed at all", () => {
    const html = renderToStaticMarkup(
      <ToolCall part={dynamicToolPart("search_docs")} />,
    );

    expect(html).not.toContain("<iframe");
  });
});
