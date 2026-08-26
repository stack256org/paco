import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * The Evals surface must be linked to from somewhere a user can get to.
 *
 * This is the reviewer's own grep, made executable. The subsystem shipped
 * complete and correct — runner, discovery, terminal statuses — and entirely
 * invisible: an exhaustive search for `evals` in any `href`/`Link`/nav across
 * `app/` and `components/` returned nothing outside the evals directory
 * itself, so the only way in was typing the URL.
 *
 * A source scan rather than a render test on purpose. What was missing was
 * not a broken link but the absence of any link at all, and that is a fact
 * about the tree, not about one component's output — a render test would
 * have passed happily on the day the bug was introduced, asserting only on a
 * component nothing ever mounted. This fails again the moment the last route
 * into Evals is deleted, wherever that route lives.
 *
 * Reachability is two facts, and both are checked, because either alone is
 * satisfiable while the page stays unreachable:
 *
 *  1. some module renders a link to `/sessions/<id>/evals`; and
 *  2. something OUTSIDE the evals directory mounts that module (or carries
 *     the link itself).
 *
 * A link inside a component nothing imports is exactly as unreachable as no
 * link at all.
 */

const WEB_ROOT = path.join(import.meta.dir, "..", "..", "..", "..");
const SCAN_ROOTS = ["app", "components"];
const EVALS_DIR = path.join(
  WEB_ROOT,
  "app",
  "sessions",
  "[sessionId]",
  "evals",
);
const SKIP_DIRS = new Set(["node_modules", ".next"]);

/**
 * A link to the evals route, however the session id is interpolated —
 * `/sessions/${sessionId}/evals`, `/sessions/[sessionId]/evals`, a template
 * built from a `sessionId` variable all count.
 *
 * The path has to be a STRING LITERAL, hence the required opening quote or
 * backtick: this same route path appears in prose inside docstrings all over
 * the codebase, and a comment mentioning a page is exactly the kind of
 * thing that makes an unreachable page look reachable.
 */
const EVALS_HREF = /["'`]\/sessions\/[^"'`\s]*\/evals/;

/**
 * Comments removed before matching, for the same reason: a prose reference
 * that happens to sit inside quotes is still prose.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      yield* sourceFiles(full);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

type Scanned = { file: string; source: string; insideEvals: boolean };

async function scanSources(): Promise<Scanned[]> {
  const scanned: Scanned[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of sourceFiles(path.join(WEB_ROOT, root))) {
      scanned.push({
        file,
        source: stripComments(await readFile(file, "utf-8")),
        insideEvals: file.startsWith(EVALS_DIR),
      });
    }
  }
  return scanned;
}

const sources = await scanSources();

/** Modules that actually render a link to the evals route. */
const linkingModules = sources.filter((entry) => EVALS_HREF.test(entry.source));

/**
 * Whether `file` is imported by anything outside the evals directory.
 *
 * Matched on the module specifier's basename, which is enough here: this
 * only ever asks about files under the evals directory, and every import of
 * one names it by path.
 */
function isMountedFromOutsideEvals(file: string): boolean {
  const moduleName = path.basename(file).replace(/\.tsx?$/, "");
  const importsIt = new RegExp(`from\\s+["'][^"']*evals/${moduleName}["']`);
  return sources.some(
    (entry) => !entry.insideEvals && importsIt.test(entry.source),
  );
}

describe("the Evals surface is reachable", () => {
  test("something renders a link to /sessions/<id>/evals", () => {
    expect(
      linkingModules.map((entry) => path.relative(WEB_ROOT, entry.file)),
    ).not.toEqual([]);
  });

  test("that link is mounted from outside the evals directory", () => {
    const reachable = linkingModules.filter(
      (entry) => !entry.insideEvals || isMountedFromOutsideEvals(entry.file),
    );

    expect(
      reachable.map((entry) => path.relative(WEB_ROOT, entry.file)),
    ).not.toEqual([]);
  });
});
