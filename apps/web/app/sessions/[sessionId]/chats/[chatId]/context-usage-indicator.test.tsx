import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("server-only", () => ({}));

const { ContextUsageIndicator } = await import("./context-usage-indicator");

/**
 * The context dial is a button on some backends and a readout on others, and
 * the difference has to be legible.
 *
 * Claude Code can be asked to compact (`/compact`). Poolside cannot: it
 * compacts on its own and exposes no client-callable way in — verified
 * against `pool` 1.0.16, where `session/compact`, `session/summarize` and
 * `poolside/compact` all answer "Method not found" and `availableCommands`
 * is null. So the control has to disappear where it cannot work, instead of
 * rendering everywhere and failing on click.
 *
 * Scope note: the tooltip BODY is not asserted here and cannot be. Base UI
 * mounts tooltip content only once open, so `renderToStaticMarkup` never
 * emits it — an assertion on the reason text would pass whether or not the
 * component rendered it. What is checked is what the markup actually
 * decides: whether the dial is operable, and what it announces.
 */

const BASE = {
  inputTokens: 40_000,
  conversationInputTokens: 40_000,
  conversationCachedInputTokens: 0,
  conversationOutputTokens: 1_000,
  contextLimit: 200_000,
};

function render(props: Parameters<typeof ContextUsageIndicator>[0]): string {
  return renderToStaticMarkup(<ContextUsageIndicator {...props} />);
}

describe("ContextUsageIndicator", () => {
  test("is an operable button when the backend can compact", () => {
    const html = render({ ...BASE, onCompact: () => undefined });

    expect(html).not.toContain("disabled=");
    // The offer is in the accessible name, not only in a hover tooltip.
    expect(html).toContain("compact this chat");
  });

  test("is an inert readout when the backend cannot", () => {
    const html = render({
      ...BASE,
      compactUnavailableReason:
        "This backend compacts its own history when it needs to, so there is nothing to trigger here.",
    });

    expect(html).toContain("disabled=");
    // It must not announce a click that would do nothing.
    expect(html).not.toContain("compact this chat");
    // The reading itself is still shown — this is a readout, not a blank.
    expect(html).toContain("20%");
  });

  test("compacting shows the spinner instead of the ring", () => {
    const html = render({
      ...BASE,
      onCompact: () => undefined,
      isCompacting: true,
    });

    expect(html).toContain("animate-spin");
    expect(html).toContain("disabled=");
  });

  test("renders nothing before a turn has reported usage", () => {
    expect(render({ ...BASE, inputTokens: 0 })).toBe("");
  });
});
