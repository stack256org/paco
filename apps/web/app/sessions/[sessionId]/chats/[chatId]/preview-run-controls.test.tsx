import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewRunControls } from "./preview-run-controls";

const noop = () => {};

describe("PreviewRunControls", () => {
  test("offers Start when nothing is running", () => {
    const html = renderToStaticMarkup(
      <PreviewRunControls
        onStart={noop}
        onStop={noop}
        running={false}
        starting={false}
        stopping={false}
      />,
    );

    expect(html).toContain("Start preview");
    expect(html).not.toContain("Stop preview");
    expect(html).toContain("btn-primary");
  });

  test("offers Stop once the app is running", () => {
    const html = renderToStaticMarkup(
      <PreviewRunControls
        onStart={noop}
        onStop={noop}
        running={true}
        starting={false}
        stopping={false}
      />,
    );

    expect(html).toContain("Stop preview");
    expect(html).not.toContain("Start preview");
  });

  test("shows a disabled busy state while starting", () => {
    const html = renderToStaticMarkup(
      <PreviewRunControls
        onStart={noop}
        onStop={noop}
        running={false}
        starting={true}
        stopping={false}
      />,
    );

    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
    expect(html).toContain("loading-spinner");
  });

  test("shows a disabled busy state while stopping", () => {
    const html = renderToStaticMarkup(
      <PreviewRunControls
        onStart={noop}
        onStop={noop}
        running={true}
        starting={false}
        stopping={true}
      />,
    );

    expect(html).toContain("Stopping…");
    expect(html).toContain("disabled");
  });

  test("renders nothing when the workspace cannot start anything", () => {
    // No handlers: the sandbox is archived or still coming up, and a button
    // that cannot work is worse than no button.
    const html = renderToStaticMarkup(
      <PreviewRunControls running={false} starting={false} stopping={false} />,
    );

    expect(html).toBe("");
  });
});
