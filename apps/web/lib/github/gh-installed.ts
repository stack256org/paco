import "server-only";

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Whether GitHub's CLI exists on this machine.
 *
 * Paco only found this out by running `gh` and catching `ENOENT`, so the one
 * page that explains it — Settings — could only show the explanation after a
 * token had already been pasted and rejected. On a fresh self-hosted install,
 * where the CLI is genuinely often absent, that is the wrong order: the user
 * does the work first and is told afterwards that no token would have helped.
 *
 * This is a PATH lookup rather than a spawn because the connection endpoint is
 * fetched on ordinary page loads, and starting a process for each one to ask a
 * question the filesystem can answer is not a trade worth making.
 */

let cached: boolean | undefined;

export function isGhInstalled(): boolean {
  cached ??= lookUpGh();
  return cached;
}

/**
 * The answer is cached for the life of the process, which is why the copy for
 * a missing CLI says to restart Paco after installing it.
 */
function lookUpGh(): boolean {
  const searchPath = process.env.PATH;
  if (!searchPath) {
    return false;
  }

  const names = process.platform === "win32" ? ["gh.exe", "gh"] : ["gh"];

  for (const dir of searchPath.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const name of names) {
      try {
        // `turbopackIgnore` because `dir` is a loop variable Next's build-time
        // file tracer cannot resolve statically. Without the hint here, the
        // tracer decides this whole module's trace is untrustworthy and falls
        // back to tracing the entire project — which is how `next.config.ts`
        // itself ended up "traced" as a runtime dependency of this route, and
        // how `.next/standalone` ended up missing real dependencies
        // (`drizzle-orm`, `postgres`) elsewhere in the build. See the same
        // note on `workspaceRoot()` in packages/sandbox/docker/connect.ts.
        accessSync(join(/* turbopackIgnore: true */ dir, name), constants.X_OK);
        return true;
      } catch {
        // Not here, or not executable. Keep looking.
      }
    }
  }

  return false;
}
