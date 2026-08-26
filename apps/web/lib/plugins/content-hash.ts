import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/** `.git` is never part of a plugin's actual content — see `listFiles`. */
function isSkipped(name: string): boolean {
  return name === ".git";
}

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
    if (isSkipped(entry.name)) {
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
 * Finds the first symlink under `dir` (depth-first), as a forward-slash
 * path relative to `rootDir`, or `undefined` if there is none.
 *
 * `Dirent.isSymbolicLink()` reflects the directory entry itself (an
 * `lstat`, not a `stat`) so a symlinked directory is caught here rather
 * than being followed and recursed into.
 */
async function findSymlinkPath(
  rootDir: string,
  dir: string,
): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (isSkipped(entry.name)) {
      continue;
    }

    const absPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      return path.relative(rootDir, absPath).split(path.sep).join("/");
    }
    if (entry.isDirectory()) {
      const found = await findSymlinkPath(rootDir, absPath);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

/**
 * Finds the first symlink anywhere under `rootDir` (`.git` excluded), as a
 * forward-slash relative path, or `undefined` if the tree contains none.
 *
 * Exported so `installPlugin` can fail closed on a fetched tree *before*
 * it is moved into place or hashed: a symlink can point outside the
 * plugin's own directory, so silently following or copying it would let an
 * installed plugin read (or, once running, serve) files it was never
 * granted access to.
 */
export async function findSymlink(
  rootDir: string,
): Promise<string | undefined> {
  return await findSymlinkPath(rootDir, rootDir);
}

/** `sha256(relPath + "\0" + bytes)`, hex-encoded. */
async function fileDigest(rootDir: string, relPath: string): Promise<string> {
  const bytes = await readFile(path.join(rootDir, relPath));
  const digest = createHash("sha256");
  digest.update(relPath, "utf-8");
  digest.update("\0");
  digest.update(bytes);
  return digest.digest("hex");
}

/**
 * Deterministic sha256 of a directory tree's content.
 *
 * Each file contributes its own digest — `sha256(relPath + "\0" + bytes)`
 * — and the final digest is `sha256` of those per-file digests, sorted and
 * joined with `"\n"`. Hashing per file first (rather than feeding one
 * `hash.update` per file into a single running digest) matters: without a
 * length-prefixed or otherwise unambiguous framing, `path1 + "\0" + bytes1
 * + path2 + "\0" + bytes2 + ...` is not injective — a file whose *content*
 * happens to contain the literal bytes `"<next-path>\0"` can make an
 * entirely different tree hash the same (see content-hash.test.ts's
 * "moving bytes between adjacent files" case for a constructed example).
 * Digesting each file separately first removes that ambiguity: the file
 * boundary is enforced by hashing, not by string concatenation.
 *
 * Throws if `rootDir` contains a symlink — defensive, since `installPlugin`
 * is expected to reject a symlink-containing tree with `findSymlink` before
 * this is ever called on it.
 */
export async function hashDirectory(rootDir: string): Promise<string> {
  const symlinkPath = await findSymlink(rootDir);
  if (symlinkPath) {
    throw new Error(`plugin contains a symlink: ${symlinkPath}`);
  }

  const relPaths = await listFiles(rootDir, rootDir);
  const digests = await Promise.all(
    relPaths.map((relPath) => fileDigest(rootDir, relPath)),
  );
  digests.sort();

  const finalDigest = createHash("sha256");
  finalDigest.update(digests.join("\n"));
  return finalDigest.digest("hex");
}
