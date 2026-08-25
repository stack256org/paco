import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignAnnotation } from "./annotations";
import type { DesignCandidateView } from "./candidate-progress";
import { DesignPanel, type DesignPanelProps } from "./design-panel";

/**
 * There is no jsdom/happy-dom in this repo's test setup (see
 * `lib/design/selector.test.ts`), so a button's `onClick` cannot be
 * dispatched through a DOM. `DesignPanel` is deliberately hook-free, which
 * means calling it as a plain function returns its element tree — enough to
 * find a control by its label and invoke the handler it was given.
 */
function walk(node: ReactNode, visit: (element: ReactElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child as ReactNode, visit);
    }
    return;
  }
  if (!isValidElement(node)) {
    return;
  }
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child as ReactNode)).join("");
  }
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

type ButtonProps = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
};

function findButton(tree: ReactNode, label: string): ButtonProps {
  let found: ButtonProps | null = null;
  walk(tree, (element) => {
    if (element.type !== "button") {
      return;
    }
    const props = element.props as ButtonProps;
    if (textOf(props.children).includes(label)) {
      found ??= props;
    }
  });
  if (!found) {
    throw new Error(`No button labelled "${label}" in the panel`);
  }
  return found;
}

function view(
  index: number,
  overrides: Partial<DesignCandidateView> = {},
): DesignCandidateView {
  return {
    index,
    status: "completed",
    previewUrl: `https://chat-d${index}.example.com`,
    ...overrides,
  };
}

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

const noop = () => {};

function props(overrides: Partial<DesignPanelProps> = {}): DesignPanelProps {
  return {
    candidates: [view(1), view(2), view(3)],
    annotations: [],
    selectedCandidate: 2,
    editingAnnotationId: null,
    busy: null,
    error: null,
    onSelectCandidate: noop,
    onInspectClick: noop,
    onAnnotationEditStart: noop,
    onAnnotationEditCancel: noop,
    onAnnotationNoteCommit: noop,
    onAnnotationRemove: noop,
    onIterate: noop,
    onAccept: noop,
    onDiscard: noop,
    ...overrides,
  };
}

describe("DesignPanel rendering", () => {
  test("renders one frame per candidate", () => {
    const html = renderToStaticMarkup(<DesignPanel {...props()} />);

    expect(html).toContain("Candidate 1");
    expect(html).toContain("Candidate 2");
    expect(html).toContain("Candidate 3");
    expect(html.match(/<iframe/g)).toHaveLength(3);
  });

  test("renders two frames for a two-candidate turn", () => {
    const html = renderToStaticMarkup(
      <DesignPanel {...props({ candidates: [view(1), view(2)] })} />,
    );

    expect(html.match(/<iframe/g)).toHaveLength(2);
    expect(html).not.toContain("Candidate 3");
  });

  test("shows each candidate's own status while the turn runs", () => {
    const html = renderToStaticMarkup(
      <DesignPanel
        {...props({
          candidates: [
            view(1, { status: "running", previewUrl: null }),
            view(2, { status: "committing", previewUrl: null }),
            view(3, { status: "failed", error: "ran out of turns" }),
          ],
        })}
      />,
    );

    expect(html).toContain("Designing");
    expect(html).toContain("Committing");
    expect(html).toContain("Failed");
    expect(html).toContain("ran out of turns");
  });

  test("renders a chip per annotation, labelled selector and note", () => {
    const html = renderToStaticMarkup(
      <DesignPanel
        {...props({
          annotations: [
            annotation({ id: "a1", note: "make it bigger" }),
            annotation({ id: "a2", selector: "#cta", note: "" }),
          ],
        })}
      />,
    );

    expect(html).toContain("#hero: make it bigger");
    expect(html).toContain("#cta");
  });

  test("uses daisyUI chrome rather than hand-rolled boxes", () => {
    const html = renderToStaticMarkup(<DesignPanel {...props()} />);

    expect(html).toContain("card");
    expect(html).toContain("btn");
    expect(html).toContain("radio");
  });

  test("shows an action error above the frames", () => {
    const html = renderToStaticMarkup(
      <DesignPanel {...props({ error: "That merge was refused." })} />,
    );

    expect(html).toContain("That merge was refused.");
    expect(html).toContain("alert");
  });
});

describe("DesignPanel actions", () => {
  test("Accept calls the action with the selected candidate", () => {
    const accepted: number[] = [];
    const tree = DesignPanel(
      props({
        selectedCandidate: 3,
        onAccept: (index) => accepted.push(index),
      }),
    );

    const button = findButton(tree, "Accept candidate 3");
    button.onClick?.();

    expect(accepted).toEqual([3]);
  });

  test("Accept is disabled while the chosen candidate is still running", () => {
    const tree = DesignPanel(
      props({
        selectedCandidate: 1,
        candidates: [view(1, { status: "running", previewUrl: null }), view(2)],
      }),
    );

    expect(findButton(tree, "Accept candidate 1").disabled).toBe(true);
  });

  test("Accept is disabled while another design action is in flight", () => {
    const tree = DesignPanel(props({ busy: "accepting" }));
    expect(findButton(tree, "Accept candidate 2").disabled).toBe(true);
  });

  test("Iterate is disabled until an annotation on that candidate has a note", () => {
    const withoutNotes = DesignPanel(
      props({ annotations: [annotation({ note: "" })] }),
    );
    expect(findButton(withoutNotes, "Iterate on candidate 2").disabled).toBe(
      true,
    );

    const withNotes = DesignPanel(props({ annotations: [annotation()] }));
    expect(findButton(withNotes, "Iterate on candidate 2").disabled).toBe(
      false,
    );
  });

  test("Iterate calls back once the notes are there", () => {
    let iterated = 0;
    const tree = DesignPanel(
      props({
        annotations: [annotation()],
        onIterate: () => {
          iterated++;
        },
      }),
    );

    findButton(tree, "Iterate on candidate 2").onClick?.();
    expect(iterated).toBe(1);
  });

  test("Discard cleans the candidates up", () => {
    let discarded = 0;
    const tree = DesignPanel(
      props({
        onDiscard: () => {
          discarded++;
        },
      }),
    );

    findButton(tree, "Discard candidates").onClick?.();
    expect(discarded).toBe(1);
  });
});
