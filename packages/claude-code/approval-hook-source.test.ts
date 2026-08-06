import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { HOOK_SOURCE } from "./approval";

/**
 * `hook/pre-tool-use.mjs` is the readable, lintable copy of the hook;
 * `HOOK_SOURCE` in `approval.ts` is the copy that actually runs, because a
 * bundled app cannot hand Claude Code a path to a file it merely imported.
 *
 * Two copies of a security control is a drift hazard, and drift here fails
 * silently: an edit to the `.mjs` looks applied, ships nothing, and the gate
 * keeps running yesterday's logic. This test is the only thing that makes the
 * duplication safe, so edit the `.mjs` and paste the result back into
 * `HOOK_SOURCE` — never one without the other.
 */
describe("PreToolUse hook source", () => {
  test("matches hook/pre-tool-use.mjs byte for byte", () => {
    const onDisk = readFileSync(
      join(import.meta.dir, "hook", "pre-tool-use.mjs"),
      "utf-8",
    );

    expect(HOOK_SOURCE).toBe(onDisk);
  });
});
