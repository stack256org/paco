import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { describeDevServerCrash } from "./hooks/dev-server-liveness";
import { PreviewNotRunning } from "./preview-not-running";

const noop = () => {};

describe("PreviewNotRunning", () => {
  test("points at the button when nothing has been started", () => {
    const html = renderToStaticMarkup(
      <PreviewNotRunning canRun={true} error={null} starting={false} />,
    );

    expect(html).toContain("Your app is not running");
    expect(html).toContain("Press Start preview above");
    expect(html).not.toContain("alert-error");
  });

  test("explains the wait while starting", () => {
    const html = renderToStaticMarkup(
      <PreviewNotRunning canRun={true} error={null} starting={true} />,
    );

    expect(html).toContain("Starting your app");
    expect(html).toContain("install and build");
  });

  test("does not offer to run an archived workspace", () => {
    const html = renderToStaticMarkup(
      <PreviewNotRunning canRun={false} error={null} starting={false} />,
    );

    expect(html).toContain("archived");
    expect(html).not.toContain("Press Start preview above");
  });

  test("a crash is shown as an alert with a way out", () => {
    const { message, lastOutput } = describeDevServerCrash({
      packagePath: "root",
      lastOutput: "SyntaxError: Unexpected token in src/App.tsx:12",
    });

    const html = renderToStaticMarkup(
      <PreviewNotRunning
        canRun={true}
        error={message}
        onStart={noop}
        output={lastOutput}
        starting={false}
      />,
    );

    expect(html).toContain("stopped running");
    expect(html).toContain("SyntaxError: Unexpected token in src/App.tsx:12");
    // As code, not as prose — it is the part someone will want to copy.
    expect(html).toContain("mockup-code");
    expect(html).toContain('role="alert"');
    expect(html).toContain("alert-error");
    // The reason and the recovery in the same place, not a red line under a
    // hint that still says "press the button above".
    expect(html).toContain("Start preview");
    expect(html).not.toContain("Press Start preview above");
  });

  test("multi-line output keeps its line breaks", () => {
    const html = renderToStaticMarkup(
      <PreviewNotRunning
        canRun={true}
        error={"first line\nsecond line"}
        onStart={noop}
        starting={false}
      />,
    );

    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("first line\nsecond line");
  });

  test("no Start button when the workspace cannot run anything", () => {
    // An archived workspace can still be carrying the message from the last
    // failure; offering a button that cannot work is worse than no button.
    const html = renderToStaticMarkup(
      <PreviewNotRunning canRun={false} error="It stopped" starting={false} />,
    );

    expect(html).toContain("It stopped");
    expect(html).not.toContain("<button");
  });

  test("the crash alert does not rely on colour alone", () => {
    const html = renderToStaticMarkup(
      <PreviewNotRunning
        canRun={true}
        error="Your app stopped running."
        onStart={noop}
        starting={false}
      />,
    );

    // An icon and words, not just a red box.
    expect(html).toContain("<svg");
    expect(html).toContain("stopped running");
  });
});
