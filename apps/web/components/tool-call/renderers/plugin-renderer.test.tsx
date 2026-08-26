import { describe, expect, test } from "bun:test";
import type { ToolRenderState } from "@paco/shared/lib/tool-state";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebAgentUIToolPart } from "@/app/types";
import {
  buildPluginToolCallMessage,
  buildRendererSrc,
  clampIframeHeight,
  isMessageFromIframe,
  PluginRenderer,
} from "./plugin-renderer";

const baseState: ToolRenderState = {
  running: false,
  interrupted: false,
  denied: false,
  approvalRequested: false,
  isActiveApproval: false,
};

function dynamicToolPart(
  overrides: Partial<WebAgentUIToolPart> = {},
): WebAgentUIToolPart {
  return {
    type: "dynamic-tool",
    toolName: "search_docs",
    toolCallId: "call-1",
    state: "output-available",
    input: { query: "hello" },
    output: { results: ["a", "b"] },
    ...overrides,
  } as WebAgentUIToolPart;
}

describe("PluginRenderer markup", () => {
  test("iframe is sandboxed with allow-scripts only — no allow-same-origin, no allow-top-navigation", () => {
    const html = renderToStaticMarkup(
      <PluginRenderer
        part={dynamicToolPart()}
        state={baseState}
        pluginId="docs-plugin"
        file="search_docs.html"
      />,
    );

    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-top-navigation");
    expect(html).not.toContain("allow-popups");
  });

  test("iframe src points at the plugin's renderer route for this plugin/file", () => {
    const html = renderToStaticMarkup(
      <PluginRenderer
        part={dynamicToolPart()}
        state={baseState}
        pluginId="docs-plugin"
        file="search_docs.html"
      />,
    );

    expect(html).toContain(
      'src="/api/plugins/renderer/docs-plugin/search_docs.html"',
    );
  });
});

describe("buildRendererSrc", () => {
  test("builds the same-origin route path, URL-encoding both segments", () => {
    expect(buildRendererSrc("docs-plugin", "search_docs.html")).toBe(
      "/api/plugins/renderer/docs-plugin/search_docs.html",
    );
  });
});

describe("buildPluginToolCallMessage", () => {
  test("carries the tool name, id, state, input, and output for a completed call", () => {
    const message = buildPluginToolCallMessage(dynamicToolPart());

    expect(message).toEqual({
      type: "paco-plugin-tool-call",
      toolName: "search_docs",
      toolCallId: "call-1",
      toolState: "output-available",
      input: { query: "hello" },
      output: { results: ["a", "b"] },
    });
  });

  test("omits output while the call has not produced one yet", () => {
    const message = buildPluginToolCallMessage(
      dynamicToolPart({
        state: "input-available",
        output: undefined,
      }),
    );

    expect(message.output).toBeUndefined();
    expect(message.toolState).toBe("input-available");
  });
});

describe("clampIframeHeight", () => {
  test("passes through a height within the allowed range", () => {
    expect(clampIframeHeight(200)).toBe(200);
  });

  test("clamps a height below the minimum up to the minimum", () => {
    expect(clampIframeHeight(1)).toBe(48);
  });

  test("clamps a height above the maximum down to the maximum", () => {
    expect(clampIframeHeight(10_000)).toBe(480);
  });

  test("falls back to the default for a non-finite height", () => {
    expect(clampIframeHeight(Number.NaN)).toBe(120);
    expect(clampIframeHeight(Number.POSITIVE_INFINITY)).toBe(120);
  });
});

describe("isMessageFromIframe", () => {
  test("is true only when event.source is this exact iframe's contentWindow", () => {
    const ourWindow = {} as Window;
    const otherWindow = {} as Window;

    expect(isMessageFromIframe({ source: ourWindow }, ourWindow)).toBe(true);
    expect(isMessageFromIframe({ source: otherWindow }, ourWindow)).toBe(false);
    expect(isMessageFromIframe({ source: null }, ourWindow)).toBe(false);
  });

  test("is false when this component has no iframe window yet", () => {
    const someWindow = {} as Window;
    expect(isMessageFromIframe({ source: someWindow }, null)).toBe(false);
  });
});
