import { describe, expect, test } from "bun:test";

/**
 * Guards the one place this repo keeps two copies of the same logic on
 * purpose: `selector.ts`'s `buildSelector` (typed, unit-tested, importable)
 * and `apps/web/public/design-inspector.js`'s copy of it (dependency-free
 * plain JS, injected into a candidate preview's page where nothing can be
 * imported — see that file's header comment).
 *
 * Neither copy can be generated from the other at build time without
 * turning `design-inspector.js` into a build artifact, which the "no build
 * step" requirement rules out. So instead: both files bracket the shared
 * logic with identical `PACO_SELECTOR_LOGIC_START`/`_END` marker comments,
 * this test extracts the text between them from each file, strips
 * TypeScript-only syntax (interfaces are kept out of the block entirely;
 * this only has to strip `export` and inline type annotations) and all
 * whitespace, and fails the moment the two stop matching byte-for-byte.
 *
 * A deliberately blunt guard, not a type checker: it does not verify the
 * script is *correct*, only that it has not silently drifted from the
 * module a human actually reviews and tests.
 */

const SELECTOR_TS_PATH = new URL("selector.ts", import.meta.url);
const DESIGN_INSPECTOR_JS_PATH = new URL(
  "../../public/design-inspector.js",
  import.meta.url,
);

const START_MARKER = "// === PACO_SELECTOR_LOGIC_START ===";
const END_MARKER = "// === PACO_SELECTOR_LOGIC_END ===";

function extractMarkedBlock(source: string, fileLabel: string): string {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `${fileLabel} is missing a well-formed PACO_SELECTOR_LOGIC block`,
    );
  }
  return source.slice(start + START_MARKER.length, end);
}

/**
 * Strip everything that is allowed to differ between the two copies —
 * TypeScript type annotations, the `export` keyword, comments, and all
 * whitespace — leaving only the logic itself to compare.
 */
function normalize(block: string): string {
  return (
    block
      // Block and line comments.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      // The `export` keyword, which only ever appears in the .ts copy.
      .replace(/\bexport\s+/g, "")
      // Inline type annotations: `: Identifier`, optionally unioned
      // (`: Identifier | Identifier`) or array-suffixed (`: Identifier[]`).
      // The shared block deliberately contains no object literals or
      // ternaries, so a bare `:` only ever introduces a type here.
      .replace(
        /:\s*[A-Za-z_$][\w$]*(?:\s*(?:\|\s*[A-Za-z_$][\w$]*|\[\]))*/g,
        "",
      )
      // Whitespace never carries meaning once the above is stripped: the
      // remaining tokens are compared as an unbroken string, not executed.
      .replace(/\s+/g, "")
  );
}

describe("selector.ts and design-inspector.js stay in sync", () => {
  test("the shared PACO_SELECTOR_LOGIC block matches after stripping types and whitespace", async () => {
    const [tsSource, jsSource] = await Promise.all([
      Bun.file(SELECTOR_TS_PATH).text(),
      Bun.file(DESIGN_INSPECTOR_JS_PATH).text(),
    ]);

    const tsBlock = extractMarkedBlock(tsSource, "selector.ts");
    const jsBlock = extractMarkedBlock(jsSource, "design-inspector.js");

    const normalizedTs = normalize(tsBlock);
    const normalizedJs = normalize(jsBlock);

    expect(normalizedTs.length).toBeGreaterThan(0);
    expect(normalizedTs).toBe(normalizedJs);
  });
});
