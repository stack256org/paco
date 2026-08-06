import "server-only";

import type { connectSandbox } from "@paco/sandbox";

type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;

/**
 * Reading and writing Paco's own bookkeeping inside a sandbox.
 *
 * `sandbox.readFile`/`writeFile`/`mkdir` refuse any path outside the chat's
 * workspace. That guard is load-bearing — it is what stops a path in a request
 * from reaching the rest of the container — and it should not be relaxed.
 *
 * But Paco keeps files of its own that deliberately do *not* live in the
 * workspace: dev-server pid and state files under `/tmp` (so they never appear
 * as untracked files in the user's repository), and code-server's settings
 * under `$HOME`. Both went through the file API, both were rejected, and in
 * both cases the failure was swallowed — the editor silently launched
 * unconfigured, and starting a dev server returned a 500 that read as the
 * sandbox being broken.
 *
 * These go through `exec` instead, which is not path-confined. That is the
 * correct distinction: these paths are Paco's, fixed at build time, and never
 * derived from user input.
 *
 * base64 on the way in and out, so no content can be misread as shell syntax
 * and no quoting scheme has to survive arbitrary bytes.
 */

const RUNTIME_FILE_TIMEOUT_MS = 10_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Create a directory, including parents, anywhere in the container. */
export async function makeRuntimeDir(
  sandbox: ConnectedSandbox,
  directory: string,
  cwd: string,
): Promise<void> {
  const result = await sandbox.exec(
    `mkdir -p ${shellQuote(directory)}`,
    cwd,
    RUNTIME_FILE_TIMEOUT_MS,
  );

  if (!result.success) {
    throw new Error(
      result.stderr.trim() || `Could not create directory ${directory}`,
    );
  }
}

/** Write a file anywhere in the container, creating its directory. */
export async function writeRuntimeFile(
  sandbox: ConnectedSandbox,
  filePath: string,
  contents: string,
  cwd: string,
): Promise<void> {
  const directory = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  const encoded = Buffer.from(contents, "utf-8").toString("base64");

  const result = await sandbox.exec(
    `mkdir -p ${shellQuote(directory)} && printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
    cwd,
    RUNTIME_FILE_TIMEOUT_MS,
  );

  if (!result.success) {
    console.error("[runtime-files] write failed:", result.stderr.trim());
    throw new Error("We couldn't save this workspace's settings.");
  }
}

/**
 * Read a file from anywhere in the container.
 *
 * Returns null when it does not exist, because every caller here treats "no
 * state recorded" the same as "no file" — a dev server that was never started
 * and one whose pid file was cleaned up are the same situation.
 */
export async function readRuntimeFile(
  sandbox: ConnectedSandbox,
  filePath: string,
  cwd: string,
): Promise<string | null> {
  const result = await sandbox.exec(
    `cat ${shellQuote(filePath)} 2>/dev/null`,
    cwd,
    RUNTIME_FILE_TIMEOUT_MS,
  );

  if (!result.success) {
    return null;
  }

  return result.stdout;
}
