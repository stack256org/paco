import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * Guards a daisyUI trap that has now bitten this codebase twice in a row.
 *
 * `.label` is `display: inline-flex; white-space: nowrap`. Both halves hurt
 * prose, and they hurt it in different ways:
 *
 * - `nowrap` means a sentence's min-content width is the whole sentence on
 *   one line. Inside `.fieldset` (a `grid-template-columns: 1fr` grid) the
 *   column cannot shrink below that, so the fieldset widens, the `w-full`
 *   inputs stretch to match, and the whole form bursts out of its card.
 * - `inline-flex` means every inline child — the text node, a `<code>`, a
 *   `<strong>` — becomes its own FLEX ITEM, laid out as side-by-side boxes
 *   with a gap, each wrapping independently. A sentence containing any
 *   inline element renders as a shattered multi-column mess.
 *
 * The second was invisible while the first was present: `nowrap` forced
 * everything onto one line, so the flex-item layout never showed. "Fixing"
 * only the `nowrap` half revealed it, which is how this reached a user.
 *
 * `.fieldset-label` is not an escape hatch — it is `display: flex`, so it
 * fails the same way.
 *
 * The rule: `.label` is for a short field label, one text node, where
 * inline-flex and a gap are exactly what you want (a word beside a control).
 * Helper text, descriptions and error messages are ordinary paragraphs. Match
 * daisyUI's muted label colour with `text-base-content/60 text-xs` and let
 * normal text layout do its job.
 */

const LABEL_PROSE = /<p[^>]*className="[^"]*\blabel\b/;

async function tsxFiles(): Promise<string[]> {
  const glob = new Glob("**/*.tsx");
  const root = new URL("../../", import.meta.url).pathname;
  const found: string[] = [];
  for await (const file of glob.scan({ cwd: root, absolute: true })) {
    if (file.includes("/node_modules/") || file.includes("/.next/")) {
      continue;
    }
    found.push(file);
  }
  return found;
}

describe("daisyUI .label is never used for prose", () => {
  test("no <p> carries the .label class", async () => {
    const offenders: string[] = [];

    for (const file of await tsxFiles()) {
      const source = await Bun.file(file).text();
      for (const [index, line] of source.split("\n").entries()) {
        if (LABEL_PROSE.test(line)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the pattern actually matches the shape it is guarding against", () => {
    // A guard that cannot fire is worse than no guard, so prove it fires —
    // this is the exact markup that shipped the bug.
    expect(LABEL_PROSE.test('<p className="label">Some description.</p>')).toBe(
      true,
    );
    expect(
      LABEL_PROSE.test('<p className="label whitespace-normal">Text</p>'),
    ).toBe(true);
    expect(
      LABEL_PROSE.test('<p className="label text-error">Bad port</p>'),
    ).toBe(true);
    // A short field label is the legitimate use and must NOT be flagged.
    expect(
      LABEL_PROSE.test('<label className="label" htmlFor="x">Address</label>'),
    ).toBe(false);
    // Nor should an unrelated class that merely contains the word.
    expect(LABEL_PROSE.test('<p className="stat-title">Total</p>')).toBe(false);
  });
});
