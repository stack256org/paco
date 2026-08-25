/**
 * Build a robust-enough CSS selector for an element the design inspector
 * was clicked on.
 *
 * This is the one piece of the inspector's logic worth unit testing, so it
 * is pulled out of `apps/web/public/design-inspector.js` into its own
 * typed module — but the script itself has to stay dependency-free plain
 * JS (see that file's header comment for why: it is injected into a
 * candidate preview's page via nginx `sub_filter`, never bundled, so it
 * cannot `import` anything). The two copies are kept in sync by hand, and
 * `selector.build-check.test.ts` is the guard that catches drift: it reads
 * both files' `PACO_SELECTOR_LOGIC` block, strips type annotations and
 * whitespace from each, and fails the moment they stop matching.
 *
 * Precedence for one element's own segment is `id` > `data-testid` >
 * `tag:nth-of-type(n)` — an id (or a `data-testid`, the next most
 * deliberate authoring signal) is assumed unique enough that climbing to
 * the element's ancestors buys nothing further, so the chain stops there.
 * Absent either, the chain climbs by `parentElement` up to
 * `MAX_SELECTOR_DEPTH` ancestors, each identified by tag name plus its
 * position among same-tag siblings.
 */

/**
 * The minimal shape this module needs from a DOM element. A real `Element`
 * satisfies this structurally with no adapter, which is what lets
 * `design-inspector.js` hand `buildSelector` the actual clicked element
 * without this module (or its tests) ever touching the DOM.
 */
export interface SelectorElement {
  readonly tagName: string;
  readonly id: string;
  readonly dataset: { readonly testid?: string };
  readonly parentElement: SelectorElement | null;
  readonly previousElementSibling: SelectorElement | null;
}

// === PACO_SELECTOR_LOGIC_START ===
// Byte-for-byte identical to design-inspector.js's copy of this block,
// modulo type annotations and `export` — see this file's header comment.
// No object literals or ternaries anywhere in this block: the drift-check
// normalizer (`selector.build-check.test.ts`) strips `: Identifier` type
// annotations with a plain regex, which cannot tell an object literal's
// `key: value` or a ternary's `cond ? a : b` apart from a real type
// annotation. Keep this block to declarations, if/while, and plain
// expressions so that regex stays safe.
export const MAX_SELECTOR_DEPTH = 6;

/**
 * A dependency-free re-implementation of the CSSOM `CSS.escape()`
 * algorithm, used when the real one is not available (`escapeForSelector`
 * below prefers the native one when it exists). Needed because this
 * module's own tests run under Bun, which has no `CSS` global, and because
 * `design-inspector.js` should not simply break if some future host page
 * runs in an environment without one either.
 */
function cssEscapeIdent(value: string): string {
  const length = value.length;
  let result = "";
  let index = -1;
  const firstCodeUnit = value.charCodeAt(0);

  while (++index < length) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x00) {
      result += "�";
      continue;
    }
    if (
      (codeUnit >= 0x01 && codeUnit <= 0x1f) ||
      codeUnit === 0x7f ||
      (index === 0 && codeUnit >= 0x30 && codeUnit <= 0x39) ||
      (index === 1 &&
        codeUnit >= 0x30 &&
        codeUnit <= 0x39 &&
        firstCodeUnit === 0x2d)
    ) {
      result += `\\${codeUnit.toString(16)} `;
      continue;
    }
    if (index === 0 && length === 1 && codeUnit === 0x2d) {
      result += `\\${value.charAt(index)}`;
      continue;
    }
    if (
      codeUnit >= 0x80 ||
      codeUnit === 0x2d ||
      codeUnit === 0x5f ||
      (codeUnit >= 0x30 && codeUnit <= 0x39) ||
      (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
      (codeUnit >= 0x61 && codeUnit <= 0x7a)
    ) {
      result += value.charAt(index);
      continue;
    }
    result += `\\${value.charAt(index)}`;
  }
  return result;
}

function escapeForSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return cssEscapeIdent(value);
}

function nthOfType(el: SelectorElement): number {
  let n = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) {
      n++;
    }
    sib = sib.previousElementSibling;
  }
  return n;
}

function segmentFor(el: SelectorElement): string {
  if (el.id) {
    return `#${escapeForSelector(el.id)}`;
  }
  const testId = el.dataset.testid;
  if (testId) {
    return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
  }
  return `${el.tagName.toLowerCase()}:nth-of-type(${nthOfType(el)})`;
}

export function buildSelector(target: SelectorElement): string {
  const segments: string[] = [];
  let el: SelectorElement | null = target;
  let depth = 0;

  while (el && depth < MAX_SELECTOR_DEPTH) {
    const segment = segmentFor(el);
    segments.unshift(segment);
    depth++;

    if (segment.startsWith("#") || segment.startsWith("[data-testid")) {
      break;
    }

    el = el.parentElement;
  }

  return segments.join(" > ");
}
// === PACO_SELECTOR_LOGIC_END ===
