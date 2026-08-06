import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchivedWorkspacesSection } from "./archived-workspaces-section";

const noop = () => {};

describe("ArchivedWorkspacesSection", () => {
  test("stays out of the way when nothing is archived", () => {
    const html = renderToStaticMarkup(
      <ArchivedWorkspacesSection
        archivedCount={0}
        onOpen={noop}
        onRestored={noop}
        surface="menu"
      />,
    );

    expect(html).toBe("");
  });

  test("announces how many archived workspaces there are", () => {
    const html = renderToStaticMarkup(
      <ArchivedWorkspacesSection
        archivedCount={3}
        onOpen={noop}
        onRestored={noop}
        surface="menu"
      />,
    );

    expect(html).toContain("Archived");
    expect(html).toContain(">3<");
    // Collapsed until asked for: the list costs a request, and archived
    // workspaces cannot change while nobody is looking at them.
    expect(html).toContain('aria-expanded="false"');
  });

  test("carries complete class strings for each surface it is mounted on", () => {
    // Tailwind only sees class names that appear whole in the source, so these
    // are picked by a literal rather than assembled.
    const menu = renderToStaticMarkup(
      <ArchivedWorkspacesSection
        archivedCount={1}
        onOpen={noop}
        onRestored={noop}
        surface="menu"
      />,
    );
    const panel = renderToStaticMarkup(
      <ArchivedWorkspacesSection
        archivedCount={1}
        onOpen={noop}
        onRestored={noop}
        surface="panel"
      />,
    );

    expect(menu).toContain("border-t");
    expect(panel).toContain("rounded-box");
  });
});
