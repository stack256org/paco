import "server-only";

import { spawn } from "node:child_process";

/**
 * Run one host command and collect its output.
 *
 * Arguments go in an array and never through a shell. Every value passed here
 * is a filesystem path assembled from a directory name Paco read off the disk,
 * and `~/.paco/workspaces/$(rm -rf ~)` is a legal directory name — `sh -c`
 * would run it. There is nothing here a shell would add.
 */
export interface HostCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Never rejects.
 *
 * A failed measurement is an answer this report shows — "we could not read
 * this" — not an exception that takes the whole page down. The three ways a
 * child process can end (a synchronous throw from `spawn`, an `error` event, a
 * `close`) therefore all resolve, and the synchronous one resolves before the
 * promise is even constructed, so there is exactly one settle site inside it.
 */
export function runHostCommand(
  command: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<HostCommandResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    });
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    /*
     * `settled` makes the body below run at most once, however many of the
     * child's events fire. The lint rule counts the two call sites (`error`
     * and `close`) and cannot see that guard, hence the suppression.
     */
    const settle = (result: HostCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // oxlint-disable-next-line promise/no-multiple-resolved -- guarded above
      resolve(result);
    };

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error: Error) => {
      settle({ ok: false, exitCode: null, stdout, stderr: error.message });
    });

    child.on("close", (code: number | null) => {
      settle({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

/** Count the non-empty lines of a command's output. */
export function countLines(output: string): number {
  return output.split("\n").filter((line) => line.trim().length > 0).length;
}
