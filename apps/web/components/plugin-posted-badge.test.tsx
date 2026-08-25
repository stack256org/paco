import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginPostedBadge } from "./plugin-posted-badge";

describe("PluginPostedBadge rendering", () => {
  test("shows the plugin id", () => {
    const html = renderToStaticMarkup(
      <PluginPostedBadge pluginId="linear-sync" />,
    );

    expect(html).toContain("via linear-sync");
  });

  test("uses the daisyUI soft/small badge classes", () => {
    const html = renderToStaticMarkup(
      <PluginPostedBadge pluginId="linear-sync" />,
    );

    expect(html).toContain('class="badge badge-soft badge-sm"');
  });

  test("titles the badge with the plugin id for a hover hint", () => {
    const html = renderToStaticMarkup(
      <PluginPostedBadge pluginId="linear-sync" />,
    );

    expect(html).toContain(
      'title="Posted by the &quot;linear-sync&quot; plugin"',
    );
  });

  test("renders a different plugin id", () => {
    const html = renderToStaticMarkup(
      <PluginPostedBadge pluginId="another-plugin" />,
    );

    expect(html).toContain("via another-plugin");
    expect(html).not.toContain("via linear-sync");
  });
});
