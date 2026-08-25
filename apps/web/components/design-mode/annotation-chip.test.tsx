import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnotationChip } from "./annotation-chip";
import type { DesignAnnotation } from "./annotations";

const noop = () => {};

function annotation(
  overrides: Partial<DesignAnnotation> = {},
): DesignAnnotation {
  return {
    id: "a1",
    candidate: 2,
    selector: "#hero",
    text: "Welcome",
    note: "make it bigger",
    ...overrides,
  };
}

function render(editing: boolean, overrides: Partial<DesignAnnotation> = {}) {
  return renderToStaticMarkup(
    <AnnotationChip
      annotation={annotation(overrides)}
      editing={editing}
      onEditCancel={noop}
      onEditStart={noop}
      onNoteCommit={noop}
      onRemove={noop}
    />,
  );
}

describe("AnnotationChip", () => {
  test("reads as '<selector-short>: <note>' when it has a note", () => {
    expect(render(false)).toContain("#hero: make it bigger");
  });

  test("shows only the selector before a note is typed", () => {
    const html = render(false, { note: "" });
    expect(html).toContain("#hero");
    expect(html).not.toContain(":  ");
  });

  test("is a daisyUI badge, not a hand-rolled box", () => {
    expect(render(false)).toContain("badge");
  });

  test("names the element it points at, for a hover hint", () => {
    expect(render(false)).toContain("Welcome");
  });

  test("offers a way to remove the note", () => {
    expect(render(false)).toContain("Remove this note");
  });

  test("swaps in an inline input, pre-filled, while editing", () => {
    const html = render(true);

    expect(html).toContain("<input");
    expect(html).toContain("input-xs");
    expect(html).toContain('value="make it bigger"');
    expect(html).toContain("Note for #hero");
  });

  test("shows nothing to remove while the input is open", () => {
    expect(render(true)).not.toContain("Remove this note");
  });
});
