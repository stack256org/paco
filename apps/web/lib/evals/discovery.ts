import "server-only";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

/**
 * One check a scenario's turn must satisfy, evaluated by `lib/evals/runner.ts`.
 *
 * `file-exists`/`file-contains` run against the throwaway chat's worktree on
 * the host (plain `fs`); `command-succeeds` runs inside the sandbox
 * (`packages/sandbox`'s `exec`, 60s timeout) so it sees the same container
 * the agent worked in; `transcript-matches` is a regex over the turn's
 * assistant text, derived from `session_events` the same way the chat UI
 * would replay it.
 */
export const evalAssertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file-exists"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("file-contains"),
    path: z.string().min(1),
    needle: z.string().min(1),
  }),
  z.object({ kind: z.literal("command-succeeds"), command: z.string().min(1) }),
  z.object({
    kind: z.literal("transcript-matches"),
    pattern: z.string().min(1),
  }),
]);

export type EvalAssertion = z.infer<typeof evalAssertionSchema>;

/**
 * A repo-defined eval scenario: `<sessionRepo>/evals/*.json`.
 *
 * `maxTurns` bounds the throwaway turn `runEvalScenario` runs it in — the
 * same kind of unattended cap `TASK_DEFAULT_MAX_TURNS` gives a task, just
 * scenario-local and much tighter (an eval is meant to be a small, fast
 * check, not an open-ended job).
 */
export const evalScenarioSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  assertions: z.array(evalAssertionSchema).min(1),
  maxTurns: z.number().int().positive().max(50).default(25),
});

export type EvalScenario = z.infer<typeof evalScenarioSchema>;

const EVALS_SUBDIR = "evals";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Discover every eval scenario in a session's repo.
 *
 * A missing `evals/` directory is not an error — most sessions never define
 * any scenarios — so it comes back as `{ scenarios: [], errors: [] }` rather
 * than a rejected promise, the same "absence is not failure" treatment
 * `listMemory` gives a missing memory directory. A file that fails to parse
 * or validate is skipped and reported in `errors` (named by filename) rather
 * than failing the whole discovery — one bad scenario file must not hide
 * every other scenario in the same repo.
 */
export async function discoverEvalScenarios(
  sessionRepoDir: string,
): Promise<{ scenarios: EvalScenario[]; errors: string[] }> {
  const evalsDir = path.join(sessionRepoDir, EVALS_SUBDIR);

  let filenames: string[];
  try {
    filenames = await fs.readdir(evalsDir);
  } catch (error) {
    if (isEnoent(error)) {
      return { scenarios: [], errors: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      scenarios: [],
      errors: [`Failed to read ${evalsDir}: ${message}`],
    };
  }

  const scenarios: EvalScenario[] = [];
  const errors: string[] = [];

  const jsonFilenames = filenames
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const filename of jsonFilenames) {
    const filePath = path.join(evalsDir, filename);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = evalScenarioSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        scenarios.push(parsed.data);
      } else {
        errors.push(`${filename}: ${parsed.error.message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${filename}: ${message}`);
    }
  }

  return { scenarios, errors };
}
