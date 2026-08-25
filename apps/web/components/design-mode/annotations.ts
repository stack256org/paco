/**
 * The notes a person leaves on a design candidate by clicking its preview.
 *
 * Pure on purpose: the click that creates an annotation arrives over
 * `postMessage` from inside an iframe (`public/design-inspector.js`), the
 * note is typed in an inline input, and the result is folded into one
 * sentence per candidate for the iteration prompt — three steps that are
 * each trivial to get subtly wrong and impossible to test through a DOM this
 * repo's test setup does not have. Everything stateful lives in
 * `design-mode-context.tsx`; everything decidable lives here.
 */

/** One clicked element on one candidate, plus whatever the user said about it. */
export interface DesignAnnotation {
  id: string;
  /** Which candidate's preview was clicked (1..3). */
  candidate: number;
  /** The CSS selector `buildSelector` produced for the clicked element. */
  selector: string;
  /** What the element read as, already trimmed to 80 chars by the inspector. */
  text: string;
  /** The user's own note. Empty until they type one. */
  note: string;
}

/**
 * How many trailing selector segments a chip shows.
 *
 * `buildSelector` climbs up to six ancestors, which is the right amount of
 * context for the agent and far too much for a chip: the tail is the part
 * that identifies the element to a human looking at the page.
 */
const SELECTOR_LABEL_SEGMENTS = 2;

const SELECTOR_SEPARATOR = " > ";

/** The tail of a selector chain — what a chip can show without wrapping. */
export function shortSelector(selector: string): string {
  const segments = selector.split(SELECTOR_SEPARATOR);
  if (segments.length <= SELECTOR_LABEL_SEGMENTS) {
    return selector;
  }
  return segments.slice(-SELECTOR_LABEL_SEGMENTS).join(SELECTOR_SEPARATOR);
}

/** A chip's text: `<selector-short>: <note>`, or just the selector until then. */
export function annotationLabel(annotation: DesignAnnotation): string {
  const short = shortSelector(annotation.selector);
  const note = annotation.note.trim();
  return note ? `${short}: ${note}` : short;
}

export function addAnnotation(
  annotations: DesignAnnotation[],
  input: { id: string; candidate: number; selector: string; text: string },
): DesignAnnotation[] {
  return [...annotations, { ...input, note: "" }];
}

export function setAnnotationNote(
  annotations: DesignAnnotation[],
  id: string,
  note: string,
): DesignAnnotation[] {
  return annotations.map((annotation) =>
    annotation.id === id ? { ...annotation, note } : annotation,
  );
}

export function removeAnnotation(
  annotations: DesignAnnotation[],
  id: string,
): DesignAnnotation[] {
  return annotations.filter((annotation) => annotation.id !== id);
}

export function annotationsForCandidate(
  annotations: DesignAnnotation[],
  candidate: number,
): DesignAnnotation[] {
  return annotations.filter((annotation) => annotation.candidate === candidate);
}

/** Whether iterating on this candidate would say anything at all. */
export function hasIterableAnnotations(
  candidate: number,
  annotations: DesignAnnotation[],
): boolean {
  return annotationsForCandidate(annotations, candidate).some(
    (annotation) => annotation.note.trim().length > 0,
  );
}

/**
 * The message an "Iterate" press sends, composed from one candidate's chips.
 *
 * Annotations with no note are skipped rather than sent as a bare selector:
 * "change this element" with no instruction is worse than not mentioning the
 * element at all, and the Iterate control is disabled until at least one note
 * exists (`hasIterableAnnotations`), so this only ever drops the extra chips
 * a user left half-filled.
 */
export function composeIterationPrompt(
  candidate: number,
  annotations: DesignAnnotation[],
): string {
  const items = annotationsForCandidate(annotations, candidate)
    .filter((annotation) => annotation.note.trim().length > 0)
    .map((annotation) => {
      const excerpt = annotation.text.trim();
      const target = excerpt
        ? `${annotation.selector} ("${excerpt}")`
        : annotation.selector;
      return `${target} — ${annotation.note.trim()}.`;
    });

  if (items.length === 0) {
    return "";
  }

  return `On candidate ${candidate}: ${items.join(" ")}`;
}
