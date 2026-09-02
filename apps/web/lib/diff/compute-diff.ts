import type { Sandbox } from "@paco/sandbox";
import {
  buildUntrackedDiffFile,
  isGeneratedFile,
  parseNameStatus,
  parseStats,
  resolveBaseRef,
  splitDiffByFile,
  unescapeGitPath,
} from "@/app/api/sessions/[sessionId]/diff/_lib/diff-utils";
import { updateSession } from "@/lib/db/sessions";
import {
  discoverNestedRepos,
  isNestedRepoRootRow,
  prefixPatchPaths,
  prefixPath,
  repoCwd,
  rootsWithin,
} from "@/lib/git/nested-repos";
import { isSandboxUnavailableError } from "@/lib/sandbox/utils";

/** Upper bound on untracked files inlined into a diff for a repo with no commits. */
const MAX_UNTRACKED_FILES = 500;

export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** May be absent in cached diffs created before this field was introduced. */
  stagingStatus?: "staged" | "unstaged" | "partial";
  additions: number;
  deletions: number;
  diff: string;
  /** Diff of only uncommitted (local) changes vs HEAD. Present when the file has local modifications. */
  localDiff?: string;
  oldPath?: string;
  /** True for generated/lock files whose diff content is intentionally omitted. */
  generated?: boolean;
};

export type DiffResponse = {
  files: DiffFile[];
  summary: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  };
  /** The git ref used as the diff base (e.g. "origin/main", "HEAD"). May be absent in old cached diffs. */
  baseRef?: string;
};

export class DiffComputationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DiffComputationError";
  }
}

/** One repository's share of the response, before any path prefixing. */
type RepoDiff = {
  files: DiffFile[];
  /** null: a repository with no commits yet. */
  baseRef: string | null;
  totalAdditions: number;
  totalDeletions: number;
  omittedFileCount: number;
};

/**
 * The diff of a single repository, taken in `cwd`.
 *
 * Everything here used to be `computeAndCacheDiff` itself, minus the caching.
 * It became a function of one repository when workspaces holding several
 * repositories arrived: the same questions are asked of each nested
 * repository, and the answers merged by the caller. `exclude` lets the parent
 * repository's pass drop the rows that *are* a nested repository — the opaque
 * `project/` untracked entry, the gitlink — before they are counted, since
 * the repository's real changes are reported by its own pass.
 */
async function computeDiffForRepo(
  sandbox: Sandbox,
  cwd: string,
  exclude: (path: string) => boolean = () => false,
): Promise<RepoDiff> {
  // Determine the best base ref for the diff:
  // - origin's default branch (for cloned repos)
  // - HEAD (for local repos with commits)
  // - null (for brand-new repos with no commits)
  const baseRef = await resolveBaseRef(sandbox, cwd);

  // When diffing against a remote branch (e.g. origin/main), use
  // `git merge-base` to find the common ancestor between that branch and
  // HEAD. This avoids showing unrelated changes that were merged into the
  // remote branch after the current branch was created.
  let diffRef = baseRef;
  if (baseRef && baseRef !== "HEAD") {
    const mergeBaseResult = await sandbox.exec(
      `git merge-base ${baseRef} HEAD`,
      cwd,
      10000,
    );
    if (mergeBaseResult.success && mergeBaseResult.stdout.trim()) {
      diffRef = mergeBaseResult.stdout.trim();
    }
    // If merge-base fails, fall back to the original baseRef
  }

  // Run git commands sequentially; some sandbox backends are not reliable
  // with concurrent command streams after reconnect.

  // For repos with no commits, we can only list untracked files
  if (baseRef === null) {
    const untrackedResult = await sandbox.exec(
      "git ls-files --others --exclude-standard",
      cwd,
      30000,
    );

    if (!untrackedResult.success) {
      const stderr = untrackedResult.stderr || "Unknown git error";
      if (isSandboxUnavailableError(stderr)) {
        throw new Error(stderr);
      }
      console.error("Git command failed:", stderr);
      throw new DiffComputationError(
        "We couldn't work out what changed in this workspace. Reload the page and try again.",
        400,
      );
    }

    // All files are untracked in a repo with no commits
    const files: DiffFile[] = [];
    let totalAdditions = 0;

    const allUntracked = untrackedResult.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      // `ls-files` quotes paths holding spaces-adjacent escapes or non-ASCII
      // bytes (`"caf\303\251.ts"`); read literally, that name matches no file
      // on disk and the entry silently vanished from the diff.
      .map((line) => unescapeGitPath(line))
      .filter((line) => !exclude(line));

    /*
     * Bound how many files are inlined.
     *
     * `--exclude-standard` honours .gitignore, so this only bites when a
     * workspace has none — which is exactly the case that took the server down:
     * a scaffolded Next.js app left 21,000 files under node_modules and .next
     * untracked, and reading them all built a diff too large to serialise.
     */
    const untrackedFiles = allUntracked.slice(0, MAX_UNTRACKED_FILES);
    const omittedFileCount = allUntracked.length - untrackedFiles.length;

    const untrackedFileContents = await Promise.all(
      untrackedFiles.map(async (filePath) => {
        const fullPath = `${cwd}/${filePath}`;
        try {
          const content = await sandbox.readFile(fullPath, "utf-8");
          return { path: filePath, content };
        } catch {
          return { path: filePath, content: null };
        }
      }),
    );

    for (const { path, content } of untrackedFileContents) {
      const entry = buildUntrackedDiffFile(path, content);
      if (!entry) continue;
      totalAdditions += entry.lineCount;
      files.push(entry.file);
    }

    return {
      files,
      baseRef,
      totalAdditions,
      totalDeletions: 0,
      omittedFileCount,
    };
  }

  // Normal path: we have a valid base ref to diff against.
  // Use diffRef (merge-base) so we only see changes introduced on
  // this branch, not changes merged into the remote default branch.
  const nameStatusResult = await sandbox.exec(
    `git diff ${diffRef} --name-status`,
    cwd,
    30000,
  );
  const numstatResult = await sandbox.exec(
    `git diff ${diffRef} --numstat`,
    cwd,
    30000,
  );
  // Parse name-status early so we can exclude generated/lock files from the
  // full diff. This avoids huge output that can truncate and lose diffs for
  // other files. We still get their stats from --name-status and --numstat.
  const fileStatuses = parseNameStatus(nameStatusResult.stdout);
  const excludedPaths = Array.from(fileStatuses.keys()).filter(exclude);
  for (const path of excludedPaths) {
    fileStatuses.delete(path);
  }
  const generatedExcludes = Array.from(fileStatuses.keys())
    .filter(isGeneratedFile)
    .map((p) => `":(exclude)${p}"`)
    .join(" ");
  const diffCmd = generatedExcludes
    ? `git diff ${diffRef} -- . ${generatedExcludes}`
    : `git diff ${diffRef}`;
  const diffResult = await sandbox.exec(diffCmd, cwd, 60000);
  const untrackedResult = await sandbox.exec(
    "git ls-files --others --exclude-standard",
    cwd,
    30000,
  );
  // Get staged file paths to determine staging status
  const stagedResult = await sandbox.exec(
    "git diff --cached --name-only",
    cwd,
    30000,
  );

  // Check if git commands failed (e.g., not a git repo or ref doesn't exist)
  if (!nameStatusResult.success || !diffResult.success) {
    const stderr =
      nameStatusResult.stderr || diffResult.stderr || "Unknown git error";
    if (isSandboxUnavailableError(stderr)) {
      throw new Error(stderr);
    }
    console.error("Git command failed:", stderr);
    throw new DiffComputationError(
      "We couldn't work out what changed in this workspace. Reload the page and try again.",
      400,
    );
  }

  if (!numstatResult.success || !untrackedResult.success) {
    const stderr =
      numstatResult.stderr || untrackedResult.stderr || "Unknown git error";
    if (isSandboxUnavailableError(stderr)) {
      throw new Error(stderr);
    }
  }

  // Build set of staged file paths
  const stagedFiles = new Set<string>();
  if (stagedResult.success && stagedResult.stdout.trim()) {
    for (const line of stagedResult.stdout.trim().split("\n")) {
      if (line) stagedFiles.add(unescapeGitPath(line));
    }
  }

  // Build set of unstaged (working tree) changed file paths.
  // We compare the working tree against the index to find files with
  // unstaged modifications. Combined with the staged set, this lets us
  // determine partial staging.
  const unstagedFiles = new Set<string>();
  const unstagedResult = await sandbox.exec("git diff --name-only", cwd, 30000);
  if (unstagedResult.success && unstagedResult.stdout.trim()) {
    for (const line of unstagedResult.stdout.trim().split("\n")) {
      if (line) unstagedFiles.add(unescapeGitPath(line));
    }
  }

  // Parse remaining outputs (fileStatuses already parsed above)
  const fileStats = parseStats(numstatResult.stdout);
  const fileDiffs = splitDiffByFile(diffResult.stdout);

  // Build response
  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  // Determine staging status for a file.
  // When diffing against a remote base (e.g. origin/main), a file might
  // appear in the full diff because of committed, staged, or unstaged
  // changes. We use the index-level info to classify:
  function getStagingStatus(filePath: string): DiffFile["stagingStatus"] {
    const isStaged = stagedFiles.has(filePath);
    const isUnstaged = unstagedFiles.has(filePath);
    if (isStaged && isUnstaged) return "partial";
    if (isStaged) return "staged";
    // Files that are in neither set are already committed on the branch
    // (relative to HEAD, they have no pending changes). Treat them as
    // staged since they're part of committed work.
    if (!isStaged && !isUnstaged) return "staged";
    return "unstaged";
  }

  // Collect files whose diffs are missing from the bulk output (e.g. due
  // to output truncation when the full diff is very large).
  // Skip generated/lock files — we intentionally omit their diff content.
  const missingDiffPaths: string[] = [];
  for (const [path] of fileStatuses) {
    if (!fileDiffs.has(path) && !isGeneratedFile(path)) {
      missingDiffPaths.push(path);
    }
  }

  // Fetch individual diffs for any missing files sequentially; some
  // sandbox backends are not reliable with concurrent exec streams.
  for (const filePath of missingDiffPaths) {
    const result = await sandbox.exec(
      `git diff ${diffRef} -- ${JSON.stringify(filePath)}`,
      cwd,
      30000,
    );
    const diff = result.success ? result.stdout.trim() : "";
    if (diff) {
      fileDiffs.set(filePath, diff);
    }
  }

  // Add tracked file changes
  for (const [path, statusInfo] of fileStatuses) {
    const stats = fileStats.get(path) ?? { additions: 0, deletions: 0 };
    const generated = isGeneratedFile(path);
    const diff = generated ? "" : (fileDiffs.get(path) ?? "");

    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;

    files.push({
      path,
      status: statusInfo.status,
      stagingStatus: getStagingStatus(path),
      additions: stats.additions,
      deletions: stats.deletions,
      diff,
      ...(generated && { generated: true }),
      ...(statusInfo.oldPath && { oldPath: statusInfo.oldPath }),
    });
  }

  // Add untracked files (new files)
  const untrackedFiles = untrackedResult.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    // Same unescape as the no-commits branch: a quoted path matches nothing.
    .map((line) => unescapeGitPath(line))
    .filter((line) => !exclude(line));

  // Fetch content for untracked files to generate diff
  const untrackedFileContents = await Promise.all(
    untrackedFiles.map(async (filePath) => {
      const fullPath = `${cwd}/${filePath}`;
      try {
        const content = await sandbox.readFile(fullPath, "utf-8");
        return { path: filePath, content };
      } catch {
        // Skip files we can't read (binary, permissions, etc.)
        return { path: filePath, content: null };
      }
    }),
  );

  for (const { path, content } of untrackedFileContents) {
    const entry = buildUntrackedDiffFile(path, content);
    if (!entry) continue;
    totalAdditions += entry.lineCount;
    files.push(entry.file);
  }

  // Fetch local-only diffs (uncommitted changes vs HEAD) for files with
  // local modifications. This runs `git diff HEAD -- <file>` sequentially
  // for each file that has unstaged or partially staged changes.
  for (const file of files) {
    if (
      !file.generated &&
      (file.stagingStatus === "unstaged" || file.stagingStatus === "partial")
    ) {
      const localResult = await sandbox.exec(
        `git diff HEAD -- ${JSON.stringify(file.path)}`,
        cwd,
        30000,
      );
      if (localResult.success && localResult.stdout.trim()) {
        file.localDiff = localResult.stdout.trim();
      }
    }
  }

  return {
    files,
    baseRef,
    totalAdditions,
    totalDeletions,
    omittedFileCount: 0,
  };
}

/** A nested repository's file, renamed to the path the workspace knows it by. */
function prefixDiffFile(file: DiffFile, root: string): DiffFile {
  return {
    ...file,
    path: prefixPath(root, file.path),
    diff: prefixPatchPaths(file.diff, root),
    ...(file.localDiff
      ? { localDiff: prefixPatchPaths(file.localDiff, root) }
      : {}),
    ...(file.oldPath ? { oldPath: prefixPath(root, file.oldPath) } : {}),
  };
}

/**
 * The whole workspace's diff: the worktree's repository, plus every
 * repository nested inside it.
 *
 * A workspace used as a *workspace* — several projects, each cloned into its
 * own directory — is several repositories, and git run at the root reports
 * only the root's. Each nested repository is diffed in its own directory
 * against its own base, and its files join the response under its directory
 * prefix, exactly as the Source Control panel names them. The parent's view
 * of a nested repository (an opaque untracked directory, or a gitlink) is
 * dropped in favour of the real thing.
 *
 * A nested repository that fails to answer — deleted mid-request, corrupt —
 * costs its own files and nothing else: the parent's diff still renders. The
 * parent failing is fatal, as it always was. `baseRef` is the parent's; a
 * per-repository base would be a lie in one field, and the panel only prints
 * it as a label.
 */
export async function computeAndCacheDiff(params: {
  sandbox: Sandbox;
  sessionId: string;
  /**
   * Directory the diff is taken in.
   *
   * A chat's worktree when the caller knows which chat it is asking about, so
   * the panel shows that chat's branch and nothing else. Defaults to the
   * session's repository, which is what session-wide callers want.
   */
  cwd?: string;
}): Promise<DiffResponse> {
  const { sandbox, sessionId } = params;
  const cwd = params.cwd ?? sandbox.workingDirectory;

  const roots = await discoverNestedRepos(sandbox, cwd);

  // Every repository's pass excludes the roots *within it* — the parent's
  // list is every root, and an intermediate repository holding a repository
  // of its own (`tools` around `tools/inner`) has its own opaque row to drop.
  const excludeFor = (repo: string) => {
    const within = rootsWithin(repo, roots);
    return (path: string) => isNestedRepoRootRow(path, within);
  };

  const parent = await computeDiffForRepo(sandbox, cwd, excludeFor(""));

  const files = [...parent.files];
  let totalAdditions = parent.totalAdditions;
  let totalDeletions = parent.totalDeletions;
  let omittedFileCount = parent.omittedFileCount;

  for (const root of roots) {
    try {
      const nested = await computeDiffForRepo(
        sandbox,
        repoCwd(cwd, root),
        excludeFor(root),
      );
      for (const file of nested.files) {
        files.push(prefixDiffFile(file, root));
      }
      totalAdditions += nested.totalAdditions;
      totalDeletions += nested.totalDeletions;
      omittedFileCount += nested.omittedFileCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unreachable sandbox is not a property of one repository.
      if (isSandboxUnavailableError(message)) {
        throw error;
      }
      console.error(`Failed to diff nested repository ${root}:`, message);
    }
  }

  // Sort files: modified first, then added, then renamed, then deleted
  const statusOrder = { modified: 0, added: 1, renamed: 2, deleted: 3 };
  files.sort(
    (a, b) =>
      statusOrder[a.status] - statusOrder[b.status] ||
      a.path.localeCompare(b.path),
  );

  const response: DiffResponse = {
    files,
    baseRef: parent.baseRef ?? "(no commits)",
    summary: {
      totalFiles: files.length + omittedFileCount,
      totalAdditions,
      totalDeletions,
    },
  };

  if (omittedFileCount > 0) {
    console.warn(
      `[diff] ${omittedFileCount} untracked files omitted for session ${sessionId}; add a .gitignore to exclude build output.`,
    );
  }

  // Cache diff for offline viewing (fire-and-forget)
  updateSession(sessionId, {
    cachedDiff: response,
    cachedDiffUpdatedAt: new Date(),
    linesAdded: response.summary.totalAdditions,
    linesRemoved: response.summary.totalDeletions,
  }).catch((err) =>
    // Only the message: the failing query carries the whole diff as a
    // parameter, and logging it once produced a multi-gigabyte log file.
    console.error(
      "Failed to cache diff:",
      err instanceof Error ? err.message : String(err),
    ),
  );

  return response;
}
