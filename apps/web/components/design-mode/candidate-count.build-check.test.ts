import { describe, expect, test } from "bun:test";

/**
 * Guards the second place this repo keeps two copies of one value on purpose
 * — the first being `selector.ts` / `design-inspector.js`, see
 * `lib/design/selector.build-check.test.ts` for that one.
 *
 * `DEFAULT_DESIGN_CANDIDATE_COUNT` lives in `lib/design/design-turn.ts`,
 * which is `server-only`: importing it into a client component would drag
 * server modules into the browser bundle. So the composer keeps its own
 * `COMPOSER_CANDIDATE_COUNT`. Nothing makes the two agree, and the drift
 * would be silent — the client always sends an explicit count, so a server
 * whose default had changed would keep honouring the client's stale one, and
 * the documented default would simply stop being what design mode does.
 *
 * Read as text rather than imported, for the same reason the constant is
 * duplicated in the first place: this test would otherwise have to import
 * the server-only module.
 */

const DESIGN_TURN_PATH = new URL(
  "../../lib/design/design-turn.ts",
  import.meta.url,
);
const CONTEXT_PATH = new URL("design-mode-context.tsx", import.meta.url);

/** Pulls `<name>...= <value>;` out of a source file, ignoring type annotations. */
function readNumericConstant(source: string, name: string): string {
  const match = source.match(
    new RegExp(`${name}\\s*(?::[^=]+)?=\\s*([0-9]+)\\s*;`),
  );
  if (!match?.[1]) {
    throw new Error(
      `Could not find a numeric constant named "${name}" — it was renamed or its shape changed, so this guard can no longer check it.`,
    );
  }
  return match[1];
}

describe("candidate count constants", () => {
  test("the composer's default matches the server's DEFAULT_DESIGN_CANDIDATE_COUNT", async () => {
    const [designTurn, context] = await Promise.all([
      Bun.file(DESIGN_TURN_PATH).text(),
      Bun.file(CONTEXT_PATH).text(),
    ]);

    const serverDefault = readNumericConstant(
      designTurn,
      "DEFAULT_DESIGN_CANDIDATE_COUNT",
    );
    const composerDefault = readNumericConstant(
      context,
      "COMPOSER_CANDIDATE_COUNT",
    );

    expect(composerDefault).toBe(serverDefault);
  });

  test("both are a count the workflow will actually accept", () => {
    // `runAgentWorkflow` throws for anything but 2 or 3 before creating a
    // single worktree, so a default outside that set would fail every design
    // turn rather than degrade.
    const allowed = ["2", "3"];
    return Promise.all([
      Bun.file(DESIGN_TURN_PATH).text(),
      Bun.file(CONTEXT_PATH).text(),
    ]).then(([designTurn, context]) => {
      expect(allowed).toContain(
        readNumericConstant(designTurn, "DEFAULT_DESIGN_CANDIDATE_COUNT"),
      );
      expect(allowed).toContain(
        readNumericConstant(context, "COMPOSER_CANDIDATE_COUNT"),
      );
    });
  });
});
