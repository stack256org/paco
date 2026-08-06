import * as path from "node:path";
import { workspaceRoot } from "@paco/sandbox";

/**
 * The one place that turns a workspace *name* into a path Paco may act on.
 *
 * Every destructive call takes a name, not a path, and gets its path from here.
 * A name is a single directory entry directly under the workspace root — no
 * separators, no `..`, no absolute path, nothing that resolves anywhere else.
 * The check is belt and braces: the name is validated as a segment, and the
 * resolved path is then confirmed to be a direct child of the root, so even a
 * platform quirk in `path.join` cannot produce a path outside it.
 *
 * Nothing outside `~/.paco/workspaces` is Paco's to delete.
 */
export class UnsafeWorkspaceNameError extends Error {
  name = "UnsafeWorkspaceNameError";
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeWorkspaceName(name: string): boolean {
  return (
    SAFE_NAME.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes(path.sep) &&
    !name.includes("/")
  );
}

/**
 * Resolve a workspace directory name to its absolute path, or throw.
 *
 * @param root Injectable so this is testable without touching the real home
 *   directory; production callers omit it.
 */
export function resolveWorkspacePath(name: string, root?: string): string {
  if (!isSafeWorkspaceName(name)) {
    throw new UnsafeWorkspaceNameError(
      `Not a workspace directory name: ${name}`,
    );
  }

  const base = path.resolve(root ?? workspaceRoot());
  const resolved = path.resolve(base, name);

  if (path.dirname(resolved) !== base || resolved === base) {
    throw new UnsafeWorkspaceNameError(
      `Refusing to act on a path outside the workspace root: ${name}`,
    );
  }

  return resolved;
}
