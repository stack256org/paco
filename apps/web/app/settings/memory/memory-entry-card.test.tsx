import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryEntry } from "@/lib/memory/store";
import { MemoryEntryCard } from "./memory-entry-card";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    slug: "editor-preference",
    title: "Editor preference",
    updatedAt: "2026-08-20T10:00:00.000Z",
    source: "distilled",
    body: "Prefers vim bindings.",
    ...overrides,
  };
}

const noop = () => {};
const noopSave = () => Promise.resolve(true);

/**
 * `MemoryEntryCard` is a plain client component with no portal/dialog
 * wrapper, so — unlike `AgentEditorDialog` — it renders fine headlessly via
 * `renderToStaticMarkup`, the same escape hatch `agent-editor-dialog.test.tsx`
 * uses for the fields it CAN render without a DOM.
 */
function renderCard(
  overrides: Partial<Parameters<typeof MemoryEntryCard>[0]> = {},
) {
  return renderToStaticMarkup(
    <MemoryEntryCard
      deleting={false}
      entry={entry()}
      onDelete={noop}
      onSave={noopSave}
      {...overrides}
    />,
  );
}

describe("MemoryEntryCard rendering", () => {
  test("shows the title, source, and body", () => {
    const html = renderCard();

    expect(html).toContain("Editor preference");
    expect(html).toContain("distilled");
    expect(html).toContain("Prefers vim bindings.");
  });

  test("starts read-only: no textarea until Edit is clicked", () => {
    const html = renderCard();

    expect(html).not.toContain("<textarea");
  });

  test("has an edit button labelled with the entry's title", () => {
    const html = renderCard();

    expect(html).toContain('aria-label="Edit &quot;Editor preference&quot;"');
  });

  test("has a delete button labelled with the entry's title", () => {
    const html = renderCard();

    expect(html).toContain('aria-label="Delete &quot;Editor preference&quot;"');
  });

  test("shows a spinner instead of the delete icon while deleting", () => {
    const html = renderCard({ deleting: true });

    expect(html).toContain("animate-spin");
  });

  test("renders a different entry's own title and body", () => {
    const html = renderCard({
      entry: entry({
        title: "Deploy convention",
        body: "Always deploy from main.",
        source: "promoted",
      }),
    });

    expect(html).toContain("Deploy convention");
    expect(html).toContain("Always deploy from main.");
    expect(html).toContain("promoted");
  });
});
