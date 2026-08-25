import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginCard } from "./plugin-card";
import type { PluginListRow } from "./plugin-list-row";

function plugin(overrides: Partial<PluginListRow> = {}): PluginListRow {
  return {
    id: "linear-bridge",
    source: "github:acme/linear-bridge#main",
    version: "1.2.0",
    enabled: true,
    grantedCapabilities: ["events:subscribe", "net:fetch"],
    ...overrides,
  };
}

const noop = () => {};

describe("PluginCard", () => {
  test("renders the plugin's name, version, and source", () => {
    const html = renderToStaticMarkup(
      <PluginCard
        onRemove={noop}
        onToggleEnabled={noop}
        onUpdate={noop}
        plugin={plugin()}
        removing={false}
        status="running"
        togglingEnabled={false}
        updating={false}
      />,
    );

    expect(html).toContain("linear-bridge");
    expect(html).toContain("v1.2.0");
    expect(html).toContain("github:acme/linear-bridge#main");
  });

  test("shows every granted capability as a badge", () => {
    const html = renderToStaticMarkup(
      <PluginCard
        onRemove={noop}
        onToggleEnabled={noop}
        onUpdate={noop}
        plugin={plugin({
          grantedCapabilities: ["storage:kv", "ui:panel"],
        })}
        removing={false}
        status="running"
        togglingEnabled={false}
        updating={false}
      />,
    );

    expect(html).toContain("storage:kv");
    expect(html).toContain("ui:panel");
  });

  test("says so when nothing has been granted", () => {
    const html = renderToStaticMarkup(
      <PluginCard
        onRemove={noop}
        onToggleEnabled={noop}
        onUpdate={noop}
        plugin={plugin({ grantedCapabilities: [] })}
        removing={false}
        status="not-running"
        togglingEnabled={false}
        updating={false}
      />,
    );

    expect(html).toContain("No capabilities granted.");
  });

  test("shows the polled host status", () => {
    const html = renderToStaticMarkup(
      <PluginCard
        onRemove={noop}
        onToggleEnabled={noop}
        onUpdate={noop}
        plugin={plugin()}
        removing={false}
        status="crashed"
        togglingEnabled={false}
        updating={false}
      />,
    );

    expect(html).toContain("crashed");
  });

  test("renders multiple rows from fixture data independently", () => {
    const rows = [
      plugin({ id: "one", version: "0.1.0" }),
      plugin({ id: "two", version: "2.0.0" }),
    ];

    const html = rows
      .map((row) =>
        renderToStaticMarkup(
          <PluginCard
            onRemove={noop}
            onToggleEnabled={noop}
            onUpdate={noop}
            plugin={row}
            removing={false}
            status="not-running"
            togglingEnabled={false}
            updating={false}
          />,
        ),
      )
      .join("\n");

    expect(html).toContain("one");
    expect(html).toContain("v0.1.0");
    expect(html).toContain("two");
    expect(html).toContain("v2.0.0");
  });
});
