/**
 * Nested repositories inside a chat's worktree.
 *
 * A workspace is one git repository, but nothing stops the agent — or the
 * operator — from cloning further repositories *into* it: a person running
 * three projects out of one session has three `.git` directories under the
 * worktree. Git itself never looks inside them: `git status` at the worktree
 * root reports such a directory as a single opaque `?? project/` row, and the
 * changes within it as nothing at all. Every git surface in Paco used to run
 * exactly one command at the worktree root, so a multi-project workspace
 * showed only the parent's changes — the bug this module exists to fix.
 *
 * The model: discover each nested repository once per request, run the same
 * git commands *in* each one, and present its paths prefixed with the
 * repository's directory (`project/src/app.ts`). Paths stay plain strings —
 * the UI keys rows by path and never needs to know which repository a row
 * belongs to. The routing back (which repository does `project/src/app.ts`
 * belong to?) is a longest-prefix match over the discovered roots.
 */

/** Minimal exec surface, matching `Sandbox.exec` — testable without Docker. */
export type NestedRepoExec = {
  exec(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
};

/**
 * More repositories than this in one workspace stops being a workspace and
 * starts being a mirror farm. Every discovered repository costs a handful of
 * git invocations per status poll, so the list is capped — deterministically,
 * after sorting, so the same repositories are always the ones shown.
 */
export const MAX_NESTED_REPOS = 20;

const DISCOVER_TIMEOUT_MS = 15_000;

/**
 * One `find` for every `.git` under the worktree, itself excluded.
 *
 * `-prune` on both interesting names: `node_modules` so a dependency tree is
 * never walked (a scaffolded app holds tens of thousands of files there), and
 * `.git` itself so the walk stops at a repository's door instead of
 * descending into its object store. A pruned entry is still printed, which is
 * how the `.git` entries reach stdout; the parser drops the `node_modules`
 * lines. `-maxdepth 8` bounds the walk in a workspace with no ignore rules.
 *
 * `.git` matches as a *name*, not a type: a nested worktree or submodule
 * checkout has a `.git` file rather than a directory, and both mark a
 * repository root.
 */
export const DISCOVER_NESTED_REPOS_COMMAND =
  "find . -maxdepth 8 \\( -name node_modules -prune \\) -o \\( -name .git -prune -print \\) 2>/dev/null";

/**
 * `find` output → repository roots, worktree-relative, longest first.
 *
 * Longest-first is load-bearing: `ownerOf` takes the first root that
 * prefixes a path, so a repository nested inside another repository
 * (`tools/inner` under `tools`) must be tried before its parent.
 */
export function parseNestedRepoRoots(stdout: string): string[] {
  const roots = new Set<string>();

  for (const rawLine of stdout.split("\n")) {
    let line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("./")) {
      line = line.slice(2);
    }
    // The worktree's own `.git`, printed by the same `-name` test.
    if (line === ".git") {
      continue;
    }
    if (!line.endsWith("/.git")) {
      continue;
    }
    const root = line.slice(0, -"/.git".length);
    // Defence in depth against a `find` without the prune (or output that
    // was assembled some other way): never treat a dependency as a project.
    if (
      root.length === 0 ||
      root.split("/").includes("node_modules") ||
      root.split("/").includes(".git")
    ) {
      continue;
    }
    roots.add(root);
  }

  return [...roots]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_NESTED_REPOS);
}

/** The nested repositories under `cwd`, as worktree-relative roots. */
export async function discoverNestedRepos(
  sandbox: NestedRepoExec,
  cwd: string,
): Promise<string[]> {
  const result = await sandbox.exec(
    DISCOVER_NESTED_REPOS_COMMAND,
    cwd,
    DISCOVER_TIMEOUT_MS,
  );
  // A workspace where `find` fails outright degrades to the old behaviour —
  // parent repository only — rather than to an error nobody can act on.
  if (!result.success) {
    return [];
  }
  return parseNestedRepoRoots(result.stdout);
}

/**
 * Which repository owns a worktree-relative path.
 *
 * `root` is `""` for the parent repository, otherwise one of the discovered
 * roots; `rel` is the path as that repository's own git knows it. `roots`
 * must be longest-first, as `parseNestedRepoRoots` returns them.
 */
export function ownerOf(
  path: string,
  roots: string[],
): { root: string; rel: string } {
  for (const root of roots) {
    if (path.startsWith(`${root}/`)) {
      return { root, rel: path.slice(root.length + 1) };
    }
  }
  return { root: "", rel: path };
}

/** `ownerOf` over a list, grouped: owner root → that repository's paths. */
export function groupByOwner(
  paths: string[],
  roots: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const { root, rel } = ownerOf(path, roots);
    const group = groups.get(root);
    if (group) {
      group.push(rel);
    } else {
      groups.set(root, [rel]);
    }
  }
  return groups;
}

/** A nested repository's path, as the panel shows it. */
export function prefixPath(root: string, rel: string): string {
  return root ? `${root}/${rel}` : rel;
}

/**
 * Whether a row from the *parent* repository's status is a nested
 * repository's own directory.
 *
 * The parent reports a nested repository as one row — `?? project/` when
 * untracked, `M project` when tracked as a gitlink — and both rows are traps:
 * there is no diff behind them, and staging the untracked one records a
 * gitlink, a pointer that silently replaces the project's files in any clone
 * of the parent. The panel shows the repository's real changes instead, so
 * these rows are dropped at the source.
 */
export function isNestedRepoRootRow(path: string, roots: string[]): boolean {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  return roots.includes(bare);
}

/** The directory to run a repository's git commands in. */
export function repoCwd(worktreeCwd: string, root: string): string {
  return root ? `${worktreeCwd}/${root}` : worktreeCwd;
}

/**
 * The discovered roots that live strictly *inside* one repository, as that
 * repository's own relative paths.
 *
 * The parent is not the only repository that can contain another: a project
 * cloned inside a project gives the intermediate repository its own opaque
 * `inner/` row, the same trap one level down. Every repository's status must
 * therefore be filtered against the roots within it — `rootsWithin("", …)`
 * gives the parent its list, `rootsWithin("tools", …)` gives `tools` its
 * `["inner"]`.
 */
export function rootsWithin(root: string, roots: string[]): string[] {
  if (root === "") {
    return [...roots];
  }
  return roots
    .filter((other) => other.startsWith(`${root}/`))
    .map((other) => other.slice(root.length + 1));
}

/**
 * Rewrite a nested repository's patch so its headers name the path the panel
 * shows.
 *
 * A diff taken *in* `project/` calls the file `a/src/app.ts`; the panel calls
 * it `project/src/app.ts`, and patch renderers read the file's identity off
 * the header lines. Only header lines are touched — `diff --git`, `---`,
 * `+++`, the rename/copy pairs, and the binary marker — never hunk content,
 * which also starts with `+`/`-` but never with `+++ b/`.
 *
 * Best effort by design: a path containing the literal ` b/` defeats the
 * `diff --git` line's grammar for git itself, and such a line is left alone
 * rather than half-rewritten. `/dev/null` sides are never prefixed — that
 * marker is what says "this file is new/deleted" and must survive verbatim.
 */
export function prefixPatchPaths(patch: string, root: string): string {
  if (!root || !patch) {
    return patch;
  }

  const rewritten = patch.split("\n").map((line) => {
    if (line.startsWith("diff --git ")) {
      return line.replace(
        /^diff --git ("?)a\/(.*) ("?)b\/(.*)$/,
        (_match, quoteA, oldPath, quoteB, newPath) =>
          `diff --git ${quoteA}a/${root}/${oldPath} ${quoteB}b/${root}/${newPath}`,
      );
    }
    if (line.startsWith("--- ") && !line.startsWith("--- /dev/null")) {
      return line.replace(/^--- ("?)a\//, `--- $1a/${root}/`);
    }
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      return line.replace(/^\+\+\+ ("?)b\//, `+++ $1b/${root}/`);
    }
    if (line.startsWith("rename from ")) {
      return `rename from ${root}/${line.slice("rename from ".length)}`;
    }
    if (line.startsWith("rename to ")) {
      return `rename to ${root}/${line.slice("rename to ".length)}`;
    }
    if (line.startsWith("copy from ")) {
      return `copy from ${root}/${line.slice("copy from ".length)}`;
    }
    if (line.startsWith("copy to ")) {
      return `copy to ${root}/${line.slice("copy to ".length)}`;
    }
    if (line.startsWith("Binary files ")) {
      return line.replace(
        /^Binary files ("?)a\/(.*) and ("?)b\/(.*) differ$/,
        (_match, quoteA, oldPath, quoteB, newPath) =>
          `Binary files ${quoteA}a/${root}/${oldPath} and ${quoteB}b/${root}/${newPath} differ`,
      );
    }
    return line;
  });

  return rewritten.join("\n");
}
