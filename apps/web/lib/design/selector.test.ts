import { describe, expect, test } from "bun:test";
import {
  buildSelector,
  MAX_SELECTOR_DEPTH,
  type SelectorElement,
} from "./selector";

/**
 * A minimal, hand-built fake of the DOM shape `buildSelector` needs —
 * there is no jsdom/happy-dom in this repo's test setup, and the whole
 * point of extracting `SelectorElement` as a narrow interface is that a
 * real `Element` and this fake both satisfy it without either module
 * knowing about the other.
 */
class FakeElement implements SelectorElement {
  tagName: string;
  id: string;
  dataset: { testid?: string };
  parentElement: SelectorElement | null = null;
  previousElementSibling: SelectorElement | null = null;

  constructor(
    tagName: string,
    options: { id?: string; dataset?: { testid?: string } } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    this.id = options.id ?? "";
    this.dataset = options.dataset ?? {};
  }
}

/** Chains `parentElement` for every element after the first (the target), root last. */
function chain(...elements: FakeElement[]): FakeElement {
  for (let i = 0; i < elements.length - 1; i++) {
    elements[i].parentElement = elements[i + 1];
  }
  return elements[0];
}

/** Chains `previousElementSibling` in order, first argument being earliest in the DOM. */
function siblings(...elements: FakeElement[]): void {
  for (let i = 1; i < elements.length; i++) {
    elements[i].previousElementSibling = elements[i - 1];
  }
}

describe("buildSelector", () => {
  test("an element with an id short-circuits to just #id", () => {
    const target = new FakeElement("button", { id: "submit" });
    expect(buildSelector(target)).toBe("#submit");
  });

  test("an id anywhere up the chain stops the climb there", () => {
    const root = new FakeElement("div", { id: "app" });
    const target = new FakeElement("span");
    chain(target, root);

    expect(buildSelector(target)).toBe("#app > span:nth-of-type(1)");
  });

  test("prefers data-testid over a plain tag when there is no id", () => {
    const target = new FakeElement("button", {
      dataset: { testid: "save-button" },
    });
    expect(buildSelector(target)).toBe('[data-testid="save-button"]');
  });

  test("id wins over data-testid on the same element", () => {
    const target = new FakeElement("button", {
      id: "save",
      dataset: { testid: "save-button" },
    });
    expect(buildSelector(target)).toBe("#save");
  });

  test("falls back to tag:nth-of-type when there is no id or data-testid", () => {
    const parent = new FakeElement("div", { id: "list" });
    const first = new FakeElement("li");
    const second = new FakeElement("li");
    const third = new FakeElement("li");
    siblings(first, second, third);
    chain(third, parent);

    expect(buildSelector(third)).toBe("#list > li:nth-of-type(3)");
  });

  test("nth-of-type only counts siblings sharing the same tag name", () => {
    const parent = new FakeElement("div", { id: "row" });
    const label = new FakeElement("span");
    const button = new FakeElement("button");
    siblings(label, button);
    chain(button, parent);

    expect(buildSelector(button)).toBe("#row > button:nth-of-type(1)");
  });

  test("climbs multiple tag:nth-of-type ancestors when none has an id or data-testid", () => {
    const grandparent = new FakeElement("section");
    const parent = new FakeElement("div");
    const target = new FakeElement("p");
    chain(target, parent, grandparent);

    expect(buildSelector(target)).toBe(
      "section:nth-of-type(1) > div:nth-of-type(1) > p:nth-of-type(1)",
    );
  });

  test("never climbs past MAX_SELECTOR_DEPTH ancestors", () => {
    const elements = Array.from(
      { length: MAX_SELECTOR_DEPTH + 4 },
      () => new FakeElement("div"),
    );
    // elements[0] is the target; elements[last] is the topmost ancestor —
    // none has an id or data-testid, so the climb only stops at the depth
    // cap.
    chain(...elements);

    const selector = buildSelector(elements[0]);
    expect(selector.split(" > ")).toHaveLength(MAX_SELECTOR_DEPTH);
  });

  test("escapes characters outside [a-zA-Z0-9_-] in an id", () => {
    const target = new FakeElement("div", { id: "weird:id.with space" });
    expect(buildSelector(target)).toBe("#weird\\:id\\.with\\ space");
  });

  test("escapes a leading digit the way CSS.escape does — as a hex code point", () => {
    // `#1a` is not a valid CSS selector on its own (an id may not start
    // with an unescaped digit); CSS.escape("1a") === "\\31 a", and this is
    // the case the naive per-character backslash escape used to get wrong
    // (a bare "1a" passes `[^a-zA-Z0-9_-]` unchanged, which looks fine as a
    // string but is not a selector `querySelector` can use unescaped).
    const target = new FakeElement("div", { id: "1a" });
    expect(buildSelector(target)).toBe("#\\31 a");
  });

  test("escapes a leading hyphen-digit the way CSS.escape does", () => {
    const target = new FakeElement("div", { id: "-1a" });
    expect(buildSelector(target)).toBe("#-\\31 a");
  });

  test("escapes a double quote inside a data-testid value", () => {
    const target = new FakeElement("div", {
      dataset: { testid: 'has"quote' },
    });
    expect(buildSelector(target)).toBe('[data-testid="has\\"quote"]');
  });

  test("a lone element with no ancestors, id, or data-testid", () => {
    const target = new FakeElement("body");
    expect(buildSelector(target)).toBe("body:nth-of-type(1)");
  });
});
