import {
  CHATS_DIRNAME,
  chatBranchName,
  chatDir,
  chatWorktreePath,
  REPO_DIRNAME,
  repoDir,
} from "./layout.ts";

/**
 * Minimal surface this module needs, so it is testable without Docker.
 *
 * `cwd` and `timeoutMs` are required, matching `Sandbox.exec` exactly. They
 * were optional at first, and because TypeScript compares method parameters
 * bivariantly the mismatch type-checked: callers could omit the timeout, and
 * `exec` read it as `undefined` and returned "Command timed out after
 * undefinedms" without running anything.
 */
export type WorktreeExec = {
  exec(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ success: boolean; stdout: string; stderr: string }>;
};

export type ChatWorktree = {
  /** Absolute path, valid on the host and inside the container alike. */
  path: string;
  /** Path relative to the workspace root, e.g. `chats/abc123`. */
  relativePath: string;
  /** Branch this worktree has checked out, e.g. `chat/abc123`. */
  branch: string;
};

const GIT_TIMEOUT_MS = 60_000;

/**
 * Give the repository a commit to branch from.
 *
 * `git worktree add` cannot create a branch in a repository with no commits —
 * there is no ref for the new branch to point at — so a freshly `git init`ed
 * workspace needs one before the first chat can get a worktree. An empty
 * commit is used rather than committing whatever happens to be on disk,
 * because the user's first turn should show up as their change, not as an
 * amendment to a commit Paco made.
 */
async function ensureInitialCommit(
  sandbox: WorktreeExec,
  repo: string,
): Promise<void> {
  const hasCommit = await sandbox.exec(
    "git rev-parse --verify HEAD",
    repo,
    GIT_TIMEOUT_MS,
  );
  if (hasCommit.success) {
    return;
  }

  const commit = await sandbox.exec(
    'git commit --allow-empty -m "Initial commit"',
    repo,
    GIT_TIMEOUT_MS,
  );
  if (!commit.success) {
    throw new Error(`Failed to create the initial commit: ${commit.stderr}`);
  }
}

async function branchExists(
  sandbox: WorktreeExec,
  repo: string,
  branch: string,
): Promise<boolean> {
  const result = await sandbox.exec(
    `git show-ref --verify --quiet ${JSON.stringify(`refs/heads/${branch}`)}`,
    repo,
    GIT_TIMEOUT_MS,
  );
  return result.success;
}

async function isWorktree(
  sandbox: WorktreeExec,
  worktreePath: string,
): Promise<boolean> {
  const result = await sandbox.exec(
    "git rev-parse --is-inside-work-tree",
    worktreePath,
    GIT_TIMEOUT_MS,
  );
  return result.success && result.stdout.trim() === "true";
}

/**
 * Ensure a chat has its own worktree, and return where it is.
 *
 * Idempotent, because it runs on every turn: an existing worktree is returned
 * untouched, so in-progress work is never disturbed. A chat that already has a
 * branch — from an earlier session, or after its directory was pruned — gets
 * that branch checked out again rather than a fresh one, so no work is
 * stranded on a ref nothing points at.
 *
 * Every path here is the workspace's *host* path, which the container mounts
 * at the same location. Git bakes an absolute path into each of the two files
 * that join a worktree to its repository, and the agent runs on the host while
 * this command runs in the container — so that one path has to be true on both
 * sides, or the worktree is unusable by whichever side did not create it.
 * Writing the pointers as relative paths instead does not work on the git in
 * the sandbox image: 2.39 reports a relative-pointer worktree as *prunable*,
 * and the next `git worktree prune` deletes the link outright.
 */
export async function ensureChatWorktree(
  sandbox: WorktreeExec,
  workspaceRoot: string,
  chatId: string,
): Promise<ChatWorktree> {
  const repo = repoDir(workspaceRoot);
  const worktreePath = chatDir(workspaceRoot, chatId);
  const worktree = {
    path: worktreePath,
    relativePath: chatWorktreePath(chatId),
    branch: chatBranchName(chatId),
  };

  if (await isWorktree(sandbox, worktreePath)) {
    return worktree;
  }

  await ensureInitialCommit(sandbox, repo);

  // Stale metadata blocks `worktree add` when a directory was removed without
  // git being told. Pruning first is a no-op in the healthy case.
  await sandbox.exec("git worktree prune", repo, GIT_TIMEOUT_MS);

  const add = (await branchExists(sandbox, repo, worktree.branch))
    ? `git worktree add ${JSON.stringify(worktreePath)} ${JSON.stringify(worktree.branch)}`
    : `git worktree add -b ${JSON.stringify(worktree.branch)} ${JSON.stringify(worktreePath)}`;

  const result = await sandbox.exec(add, repo, GIT_TIMEOUT_MS);
  if (!result.success) {
    throw new Error(
      `Failed to create a worktree for chat ${chatId}: ${result.stderr}`,
    );
  }

  return worktree;
}

/**
 * Remove a chat's worktree, keeping its branch.
 *
 * The branch is deliberately left behind: deleting a chat should free disk,
 * not discard commits. `ensureChatWorktree` will check the branch out again if
 * the chat comes back.
 */
export async function removeChatWorktree(
  sandbox: WorktreeExec,
  workspaceRoot: string,
  chatId: string,
): Promise<void> {
  const repo = repoDir(workspaceRoot);

  await sandbox.exec(
    `git worktree remove --force ${JSON.stringify(chatDir(workspaceRoot, chatId))}`,
    repo,
    GIT_TIMEOUT_MS,
  );
  await sandbox.exec("git worktree prune", repo, GIT_TIMEOUT_MS);
}

/**
 * Move a pre-worktree workspace into `repo/`.
 *
 * Workspaces used to be a single directory: the repository *was* the
 * workspace. Worktrees need the repository one level down so its worktrees can
 * be siblings, so an existing workspace has to be relocated once. Everything
 * except the new `repo/` and `chats/` directories moves, dotfiles included —
 * `.git` above all, since leaving it behind would orphan the history.
 *
 * Detected by the presence of `.git` at the root, which is true only of the
 * old layout, so this is a no-op on every workspace created since.
 */
export async function migrateLegacyWorkspace(
  sandbox: WorktreeExec,
  workspaceRoot: string,
): Promise<boolean> {
  const legacy = await sandbox.exec(
    `test -e .git && ! test -d ${REPO_DIRNAME} && echo legacy || echo current`,
    workspaceRoot,
    GIT_TIMEOUT_MS,
  );

  if (legacy.stdout.trim() !== "legacy") {
    return false;
  }

  const move = await sandbox.exec(
    [
      `mkdir -p ${REPO_DIRNAME}`,
      // `find -maxdepth 1` rather than a glob: shell globs skip dotfiles by
      // default, and `.git` is the one entry that absolutely must move.
      `find . -maxdepth 1 -mindepth 1 ! -name ${REPO_DIRNAME} ! -name ${CHATS_DIRNAME} -exec mv {} ${REPO_DIRNAME}/ \\;`,
    ].join(" && "),
    workspaceRoot,
    GIT_TIMEOUT_MS,
  );

  if (!move.success) {
    throw new Error(
      `Failed to move the workspace into ${REPO_DIRNAME}/: ${move.stderr}`,
    );
  }

  return true;
}
