import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchivedWorkspaceNotice } from "./archived-workspace-notice";

const noop = async () => {};

describe("ArchivedWorkspaceNotice", () => {
  test("offers a restore button, which is the whole point", () => {
    // The overlay used to say "Unarchive it to resume" with nothing to click.
    const html = renderToStaticMarkup(
      <ArchivedWorkspaceNotice
        hasRuntimeSandboxState={false}
        onRestore={noop}
      />,
    );

    expect(html).toContain("Restore");
    expect(html).not.toContain("disabled");
  });

  test("says what does and does not come back, before the click", () => {
    const html = renderToStaticMarkup(
      <ArchivedWorkspaceNotice
        hasRuntimeSandboxState={false}
        onRestore={noop}
      />,
    );

    expect(html).toContain("still here");
    expect(html).toContain("Start preview");
  });

  test("withholds restore while the container is still stopping", () => {
    const html = renderToStaticMarkup(
      <ArchivedWorkspaceNotice
        hasRuntimeSandboxState={true}
        onRestore={noop}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("few seconds");
  });
});
