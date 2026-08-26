import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SourceControlDiff,
  type SourceControlDiffProps,
} from "./source-control-diff";

const noop = () => {
  // no-op: only the rendered markup is asserted here
};

/**
 * A stand-in for the real patch renderer.
 *
 * `@pierre/diffs` paints into a shadow root from a web worker, which no server
 * renderer can produce — which is exactly why `renderPatch` is a prop. This is
 * the fake that lets the rest of the pane be asserted.
 */
const renderPatch = ({ patch }: { patch: string; path: string }) => (
  <pre className="overflow-x-auto">{patch}</pre>
);

function render(overrides: Partial<SourceControlDiffProps> = {}) {
  const props: SourceControlDiffProps = {
    diff: null,
    error: null,
    file: null,
    loading: false,
    onBack: noop,
    renderPatch,
    ...overrides,
  };
  return renderToStaticMarkup(<SourceControlDiff {...props} />);
}

const PATCH = [
  "diff --git a/src/parser.ts b/src/parser.ts",
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -1,3 +1,3 @@",
  "-const limit = 10;",
  "+const limit = 20;",
].join("\n");

describe("SourceControlDiff", () => {
  test("invites a click before anything is selected", () => {
    const html = render();

    expect(html).toContain("Pick a file");
    expect(html).not.toContain("Staged");
  });

  test("shows the patch for the file that is open", () => {
    const html = render({
      diff: { binary: false, patch: PATCH },
      file: { path: "src/parser.ts", staged: false },
    });

    expect(html).toContain("const limit = 20;");
    expect(html).toContain("src/parser.ts");
    expect(html).toContain("Working tree");
  });

  test("says which side of the index it is showing", () => {
    const staged = render({
      diff: { binary: false, patch: PATCH },
      file: { path: "src/parser.ts", staged: true },
    });

    expect(staged).toContain("Staged");
    expect(staged).not.toContain("Working tree");
  });

  test("says a binary file is binary rather than rendering its bytes", () => {
    const html = render({
      diff: { binary: true, patch: "" },
      file: { path: "public/logo.png", staged: false },
    });

    expect(html).toContain("binary file");
    expect(html).toContain("public/logo.png");
    expect(html).not.toContain("<pre");
  });

  test("shows a rename as the old path then the new one", () => {
    const html = render({
      diff: { binary: false, oldPath: "src/old-name.ts", patch: PATCH },
      file: { path: "src/new-name.ts", staged: true },
    });

    const oldAt = html.indexOf("src/old-name.ts");
    const newAt = html.indexOf("src/new-name.ts");

    expect(oldAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(-1);
    expect(oldAt).toBeLessThan(newAt);
  });

  test("waits visibly rather than showing an empty pane", () => {
    const html = render({
      file: { path: "src/parser.ts", staged: false },
      loading: true,
    });

    expect(html).toContain("Loading the diff");
    expect(html).toContain("animate-spin");
  });

  test("reports a failure in the pane that caused it", () => {
    const html = render({
      error: "The sandbox is not running.",
      file: { path: "src/parser.ts", staged: false },
    });

    expect(html).toContain("The sandbox is not running.");
    expect(html).toContain("text-error");
  });

  test("explains an empty patch instead of showing a blank box", () => {
    const html = render({
      diff: { binary: false, patch: "" },
      file: { path: "src/parser.ts", staged: true },
    });

    expect(html).toContain("Nothing is staged for this file");
  });

  test("scrolls a huge diff inside its own container", () => {
    const html = render({
      diff: {
        binary: false,
        patch: `${PATCH}\n${"+x".repeat(4000)}`,
      },
      file: { path: "src/parser.ts", staged: false },
    });

    expect(html).toContain("overflow-auto");
    expect(html).toContain("min-w-0");
  });

  test("lets a very long path wrap instead of widening the pane", () => {
    const html = render({
      diff: { binary: false, patch: PATCH },
      file: {
        path: "apps/web/app/sessions/chats/an-extremely-long-file-name-with-no-spaces.tsx",
        staged: false,
      },
    });

    expect(html).toContain("wrap-anywhere");
  });

  test("offers a way back to the list on a narrow layout", () => {
    const html = render({
      diff: { binary: false, patch: PATCH },
      file: { path: "src/parser.ts", staged: false },
    });

    expect(html).toContain("Back to the list of changes");
    expect(html).toContain("lg:hidden");
  });

  test("renders any toolbar it was handed", () => {
    const html = render({
      diff: { binary: false, patch: PATCH },
      file: { path: "src/parser.ts", staged: false },
      toolbar: <span>SPLIT TOGGLE</span>,
    });

    expect(html).toContain("SPLIT TOGGLE");
  });
});
