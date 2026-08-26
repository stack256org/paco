import type { FileChange, FileChangeStatus } from "./source-control-types";

/**
 * Read `git status --porcelain=v1 -z` into the three lists the panel shows.
 *
 * `-z`, not plain porcelain. Without it git quotes any path containing a
 * space, a quote, or a non-ASCII byte — `"src/my file.ts"`, `"caf\303\251.ts"`
 * — and a caller that splits on newlines and slices off three characters gets
 * a path that no git command will then match. With `-z` every field is
 * NUL-terminated and literal.
 *
 * A rename is two fields: the new path, then the original. That is the only
 * place the record length varies, which is why this walks the fields rather
 * than mapping over them.
 */

/** Git's own codes, plus `T` for a type change, which reads as a modification. */
function toStatus(code: string): FileChangeStatus {
  switch (code) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "U":
      return "U";
    default:
      // `M`, `T`, and anything a future git invents: a content change.
      return "M";
  }
}

/**
 * The seven index/worktree pairs that mean "conflicted".
 *
 * They are not staged and not merely modified: committing one records the
 * conflict markers. The panel needs them called out, so they come back with
 * status `U` and sit in `unstaged` — where the actions that make sense
 * (resolve, discard) live.
 */
function isUnmerged(index: string, worktree: string): boolean {
  return (
    index === "U" ||
    worktree === "U" ||
    (index === "A" && worktree === "A") ||
    (index === "D" && worktree === "D")
  );
}

export type ParsedStatus = {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
};

export function parsePorcelainZ(output: string): ParsedStatus {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: FileChange[] = [];

  // A trailing NUL leaves an empty last field; anything shorter than
  // "XY path" is not a record.
  const fields = output.split("\0");

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) {
      continue;
    }

    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    const path = entry.slice(3);
    if (!path) {
      continue;
    }

    if (index === "?" && worktree === "?") {
      untracked.push({ path, status: "A" });
      continue;
    }

    // Ignored entries only appear with --ignored, but never let one through.
    if (index === "!" && worktree === "!") {
      continue;
    }

    let oldPath: string | undefined;
    if (index === "R" || index === "C") {
      const original = fields[i + 1];
      if (original) {
        oldPath = original;
        i += 1;
      }
    }

    if (isUnmerged(index, worktree)) {
      unstaged.push({ path, status: "U" });
      continue;
    }

    if (index !== " " && index !== "?") {
      staged.push({
        path,
        status: toStatus(index),
        ...(oldPath ? { oldPath } : {}),
      });
    }

    if (worktree !== " " && worktree !== "?") {
      // The worktree half of a staged rename is a modification to the new
      // path, not a second rename: git detects renames against the index, and
      // the index already holds the new name.
      unstaged.push({ path, status: toStatus(worktree) });
    }
  }

  return { staged, unstaged, untracked };
}

/**
 * Every path a git command must name to act on one row of the panel.
 *
 * A staged rename is a single row but two index entries — the old path
 * deleted, the new path added — so unstaging or discarding it by the new name
 * alone leaves the deletion staged and the rename half-undone.
 */
export function pathsToTouch(
  requested: string[],
  status: ParsedStatus,
): string[] {
  const renameSources = new Map<string, string>();
  for (const change of status.staged) {
    if (change.oldPath) {
      renameSources.set(change.path, change.oldPath);
    }
  }

  const out = new Set<string>();
  for (const path of requested) {
    out.add(path);
    const source = renameSources.get(path);
    if (source) {
      out.add(source);
    }
  }

  return [...out];
}
