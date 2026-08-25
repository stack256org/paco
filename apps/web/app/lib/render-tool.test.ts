import { describe, expect, test } from "bun:test";
import { resolvePluginRenderer } from "./render-tool";

describe("resolvePluginRenderer", () => {
  test("matches the enabled plugin that registered a renderer for the tool name", () => {
    const match = resolvePluginRenderer("search_docs", [
      { pluginId: "docs-plugin", toolNames: ["search_docs", "fetch_doc"] },
    ]);

    expect(match).toEqual({
      pluginId: "docs-plugin",
      file: "search_docs.html",
    });
  });

  test("returns undefined when no plugin registered a renderer for the tool name", () => {
    const match = resolvePluginRenderer("bash", [
      { pluginId: "docs-plugin", toolNames: ["search_docs"] },
    ]);

    expect(match).toBeUndefined();
  });

  test("returns undefined given an empty plugin list", () => {
    expect(resolvePluginRenderer("anything", [])).toBeUndefined();
  });

  test("picks the first matching plugin when more than one registers the same tool name", () => {
    const match = resolvePluginRenderer("shared_tool", [
      { pluginId: "first-plugin", toolNames: ["shared_tool"] },
      { pluginId: "second-plugin", toolNames: ["shared_tool"] },
    ]);

    expect(match?.pluginId).toBe("first-plugin");
  });
});
