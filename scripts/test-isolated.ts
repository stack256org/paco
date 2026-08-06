import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";

const testPatterns = ["**/*.test.ts", "**/*.test.tsx"];

function isIgnoredPath(path: string): boolean {
  return path.startsWith("node_modules/") || path.startsWith(".");
}

async function collectTestFiles(): Promise<string[]> {
  const files = new Set<string>();

  for (const pattern of testPatterns) {
    for await (const path of glob(pattern)) {
      if (isIgnoredPath(path)) {
        continue;
      }
      files.add(path);
    }
  }

  return [...files].sort((a, b) => a.localeCompare(b));
}

/**
 * Bun's default per-test timeout is 5s, which is comfortable on a developer's
 * machine and too tight on a shared CI runner: `apps/web/app/workflows/
 * chat.test.ts` runs in ~8s locally and ~25s on GitHub's runners, and three of
 * its `runAgentWorkflow` cases were failing there purely on the clock while
 * passing every time locally.
 *
 * Raised rather than removed. A test that genuinely hangs should still fail
 * rather than wedge the run until the job's own timeout kills it with no
 * useful output.
 */
const TEST_TIMEOUT_MS = 30_000;

async function runTestsIndividually(files: string[]): Promise<void> {
  for (const file of files) {
    console.log(`\nRunning ${file}`);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const childProcess = spawn(
        "bun",
        ["test", "--timeout", String(TEST_TIMEOUT_MS), file],
        {
          stdio: "inherit",
        },
      );

      childProcess.on("error", reject);
      childProcess.on("close", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`Test failed: ${file}`);
    }
  }
}

async function main() {
  const files = await collectTestFiles();

  if (files.length === 0) {
    console.log("No test files found.");
    return;
  }

  console.log(`Running ${files.length} test files in isolated processes...`);
  await runTestsIndividually(files);
  console.log("\nAll isolated tests passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
