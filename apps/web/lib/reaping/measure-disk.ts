import "server-only";

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspaceRoot } from "@paco/sandbox";
import { runHostCommand } from "./run-host-command";
import type { WorkspaceSnapshot } from "./types";

const DU_TIMEOUT_MS = 120_000;

/**
 * Measure a directory, for real.
 *
 * `du -sk` rather than a recursive `fs.stat` walk, and rather than any kind of
 * estimate. A workspace is mostly `node_modules`: walking it in Node means
 * hundreds of thousands of syscalls through the event loop, while `du` is one
 * process doing the same work in C. It also reports *allocated* blocks, which
 * is the number that matches what the operator sees in Finder or `df` — the
 * apparent size of a tree full of small files understates the disk it holds.
 *
 * Returns null when the measurement failed, which callers must show as
 * "unknown" rather than as zero. A reaping report that quietly prints 0 GB for
 * a directory it could not read is exactly the lie this whole feature exists to
 * stop telling.
 */
export async function measureDirectoryBytes(
  directory: string,
): Promise<number | null> {
  const result = await runHostCommand("du", ["-sk", directory], DU_TIMEOUT_MS);

  if (!result.ok) {
    return null;
  }

  // "80\t/path/to/dir" — kilobytes first, then the path, which may contain
  // anything, so only the leading field is parsed.
  const kilobytes = Number.parseInt(
    result.stdout.trim().split(/\s+/)[0] ?? "",
    10,
  );
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

export interface WorkspaceDirectory {
  name: string;
  path: string;
  modifiedAtMs: number;
}

/**
 * Every directory sitting directly under the workspace root.
 *
 * Only directories, and only direct children — the root holds one entry per
 * session and nothing else. A missing root is not an error: it means no sandbox
 * has ever been created here.
 */
export async function listWorkspaceDirectories(
  root = workspaceRoot(),
): Promise<WorkspaceDirectory[]> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const directories: WorkspaceDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const directoryPath = path.join(root, entry.name);
    let modifiedAtMs = 0;
    try {
      modifiedAtMs = (await fs.stat(directoryPath)).mtimeMs;
    } catch {
      // A directory that vanished between the listing and the stat is simply
      // reported with no timestamp; it will be gone from the next report.
    }
    directories.push({ name: entry.name, path: directoryPath, modifiedAtMs });
  }

  return directories.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turn a directory listing into snapshots with measured sizes.
 *
 * Measured one at a time rather than in parallel: `du` is disk-bound, and a
 * dozen of them racing on the same volume takes longer in total than running
 * them in order while making the machine unusable in the meantime.
 */
export async function snapshotWorkspaces(
  directories: WorkspaceDirectory[],
  probeUnsavedWork: (
    directory: string,
  ) => Promise<WorkspaceSnapshot["unsavedWork"]>,
): Promise<WorkspaceSnapshot[]> {
  const snapshots: WorkspaceSnapshot[] = [];

  for (const directory of directories) {
    const sizeBytes = await measureDirectoryBytes(directory.path);
    snapshots.push({
      name: directory.name,
      path: directory.path,
      // A failed measurement is reported as 0 here — arithmetic downstream
      // needs a number — but `measured: false` is what keeps that 0 from
      // being mistaken for a real reading: `summarize` in `./classify.ts`
      // counts it separately, and the health card surfaces that count
      // rather than rendering a total that quietly excludes it.
      sizeBytes: sizeBytes ?? 0,
      measured: sizeBytes !== null,
      modifiedAtMs: directory.modifiedAtMs,
      unsavedWork:
        sizeBytes === null ? null : await probeUnsavedWork(directory.path),
    });
  }

  return snapshots;
}
