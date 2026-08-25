import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * Recursively lists every regular file under `dir`, as forward-slash
 * relative paths from `rootDir`.
 *
 * `.git` directories are skipped entirely (not just their contents): a
 * plugin fetched via `git clone` carries one, and its objects have nothing
 * to do with the plugin's actual content — including them would make the
 * hash depend on clone history/refs rather than the tree being installed.
 */
async function listFiles(rootDir: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const relPaths: string[] = [];

  for (const entry of entries) {
    if (entry.name === ".git" && entry.isDirectory()) {
      continue;
    }

    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      relPaths.push(...(await listFiles(rootDir, absPath)));
    } else if (entry.isFile()) {
      relPaths.push(path.relative(rootDir, absPath).split(path.sep).join("/"));
    }
  }

  return relPaths;
}

/**
 * Deterministic sha256 of a directory tree's content.
 *
 * Relative paths are sorted before hashing, so the digest depends only on
 * the final tree — not on the order files happened to be created or
 * discovered — and each file contributes `path + "\0" + bytes` so that
 * renaming a file (not just changing its bytes) changes the hash.
 */
export async function hashDirectory(rootDir: string): Promise<string> {
  const relPaths = (await listFiles(rootDir, rootDir)).sort();

  const hash = createHash("sha256");
  for (const relPath of relPaths) {
    const bytes = await readFile(path.join(rootDir, relPath));
    hash.update(relPath, "utf-8");
    hash.update("\0");
    hash.update(bytes);
  }

  return hash.digest("hex");
}
