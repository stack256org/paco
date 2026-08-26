import type { BackendCapabilities } from "@paco/agent-backend";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UnviewableImageNotice } from "./unviewable-image-notice";

const SIGHTED: BackendCapabilities = {
  id: "claude-code",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: true,
  subagents: true,
  images: true,
  compaction: true,
};

const BLIND: BackendCapabilities = {
  ...SIGHTED,
  id: "poolside",
  images: false,
  compaction: false,
};

describe("UnviewableImageNotice", () => {
  test("says nothing when the backend can see images", () => {
    expect(
      renderToStaticMarkup(
        <UnviewableImageNotice capabilities={SIGHTED} imageCount={2} />,
      ),
    ).toBe("");
  });

  test("says nothing when no image is attached", () => {
    expect(
      renderToStaticMarkup(
        <UnviewableImageNotice capabilities={BLIND} imageCount={0} />,
      ),
    ).toBe("");
  });

  /**
   * The whole point: attaching a screenshot to a Poolside chat must not look
   * identical to attaching one to a Claude Code chat. Today it does, and the
   * agent is silently blind to it.
   */
  test("warns, in the composer, when an image is attached to a blind backend", () => {
    const html = renderToStaticMarkup(
      <UnviewableImageNotice capabilities={BLIND} imageCount={1} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("can&#x27;t see images");
  });

  test("tells the user what will actually happen, not just that something is wrong", () => {
    const html = renderToStaticMarkup(
      <UnviewableImageNotice capabilities={BLIND} imageCount={1} />,
    );

    // The file IS delivered — it is staged to disk and named in the prompt —
    // so "your image will be ignored" would be its own small lie.
    expect(html).toContain("file");
    expect(html).toContain("Describe what matters");
  });

  test("counts, so several attached images do not read as one", () => {
    const html = renderToStaticMarkup(
      <UnviewableImageNotice capabilities={BLIND} imageCount={3} />,
    );
    expect(html).toContain("These 3 images");
  });

  test("is capability-driven, not keyed off the backend id", () => {
    // `capabilities.effort === false` hides the effort control; the same rule
    // applies here. A `backend === "poolside"` check would be wrong the day a
    // Poolside model gains vision, and wrong for every other blind backend.
    const unknownBlindBackend: BackendCapabilities = {
      ...BLIND,
      id: "some-future-backend",
    };
    expect(
      renderToStaticMarkup(
        <UnviewableImageNotice
          capabilities={unknownBlindBackend}
          imageCount={1}
        />,
      ),
    ).toContain("can&#x27;t see images");
  });
});
