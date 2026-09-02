"use server";

import { connectSandbox } from "@paco/sandbox";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getSessionById } from "@/lib/db/sessions";
import {
  BAD_FILE_SELECTION,
  SESSION_NOT_FOUND,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { shellQuote } from "@/lib/shell/quote";
import {
  discoverNestedRepos,
  isNestedRepoRootRow,
  ownerOf,
  repoCwd,
  rootsWithin,
} from "@/lib/git/nested-repos";

/**
 * What the user reads when a git command fails here.
 *
 * Discarding is one button in a confirmation dialog, and that dialog shows
 * whatever this throws. Git's own stderr — `error: pathspec 'x' did not match
 * any file(s) known to git` — tells the person who pressed the button nothing
 * they can use, so the raw text goes to the log and this goes to the dialog.
 */
const DISCARD_FAILED =
  "We couldn't discard those changes. Reload the page and try again.";

const DISCARD_CHECK_FAILED =
  "We couldn't check what had changed. Reload the page and try again.";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isPathspecError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("pathspec") &&
    normalized.includes("did not match any files")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidRepoRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\0")) {
    return false;
  }

  return value.split("/").every((segment) => {
    return (
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      segment !== ".git"
    );
  });
}

/** Raw git output — for `isPathspecError` and the log, never for the dialog. */
function toGitOutput(result: { stderr?: string; stdout?: string }): string {
  return result.stderr?.trim() || result.stdout?.trim() || "Git command failed";
}

function logGitFailure(
  step: string,
  result: { stderr?: string; stdout?: string },
): void {
  console.error(`[discard] ${step} failed:`, toGitOutput(result));
}

async function ensurePathHasUncommittedChanges(params: {
  cwd: string;
  path: string;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { cwd, path, sandbox } = params;
  const statusResult = await sandbox.exec(
    `git status --porcelain=v1 -- ${shellQuote(path)}`,
    cwd,
    10000,
  );
  if (!statusResult.success) {
    logGitFailure("status", statusResult);
    return { ok: false, error: DISCARD_CHECK_FAILED };
  }

  if (statusResult.stdout.trim().length === 0) {
    return {
      ok: false,
      error: "That file has no unsaved changes to discard.",
    };
  }

  return { ok: true };
}

async function discardPathChanges(params: {
  cwd: string;
  path: string;
  hasHead: boolean;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { cwd, path, hasHead, sandbox } = params;
  const quotedPath = shellQuote(path);
  const trackedResult = await sandbox.exec(
    `git ls-files --error-unmatch -- ${quotedPath}`,
    cwd,
    10000,
  );

  if (trackedResult.success) {
    if (hasHead) {
      const restoreResult = await sandbox.exec(
        `git restore --source=HEAD --staged --worktree -- ${quotedPath}`,
        cwd,
        30000,
      );
      if (!restoreResult.success) {
        logGitFailure("restore", restoreResult);
        return { ok: false, error: DISCARD_FAILED };
      }
      return { ok: true };
    }

    const clearIndexResult = await sandbox.exec(
      `git rm -rf --cached -- ${quotedPath}`,
      cwd,
      30000,
    );
    if (
      !clearIndexResult.success &&
      !isPathspecError(toGitOutput(clearIndexResult))
    ) {
      logGitFailure("rm --cached", clearIndexResult);
      return { ok: false, error: DISCARD_FAILED };
    }
  }

  const removeResult = await sandbox.exec(
    `rm -rf -- ${quotedPath}`,
    cwd,
    30000,
  );
  if (!removeResult.success) {
    logGitFailure("remove", removeResult);
    return { ok: false, error: DISCARD_FAILED };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// server action
// ---------------------------------------------------------------------------

/**
 * Discard uncommitted changes in the session sandbox.
 */
export async function discardChanges(params: {
  /** Discard in this chat\'s worktree; without it, the session\'s repository. */
  chatId?: string;
  sessionId: string;
  filePath?: string;
  oldPath?: string;
}): Promise<{ discarded: boolean; hasUncommittedChanges: boolean }> {
  const { sessionId, filePath, oldPath } = params;

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }

  // Nothing the user types reaches these, so the copy points at the reload
  // that clears a stale file list rather than blaming what they picked.
  if (filePath !== undefined && !isNonEmptyString(filePath)) {
    throw new Error(BAD_FILE_SELECTION);
  }
  if (oldPath !== undefined && !isNonEmptyString(oldPath)) {
    throw new Error(BAD_FILE_SELECTION);
  }
  if (!filePath && oldPath) {
    throw new Error(BAD_FILE_SELECTION);
  }
  if (filePath && !isValidRepoRelativePath(filePath)) {
    throw new Error(BAD_FILE_SELECTION);
  }
  if (oldPath && !isValidRepoRelativePath(oldPath)) {
    throw new Error(BAD_FILE_SELECTION);
  }

  const targetPaths = Array.from(
    new Set([filePath, oldPath].filter(isNonEmptyString)),
  );

  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  const cwd = resolveWorkCwd(sessionRecord.sandboxState, params.chatId);

  // verify git repo
  const repoResult = await sandbox.exec(
    "git rev-parse --show-toplevel",
    cwd,
    10000,
  );
  if (!repoResult.success) {
    logGitFailure("rev-parse --show-toplevel", repoResult);
    throw new Error(
      "This workspace has no version history yet, so there's nothing to discard.",
    );
  }

  /*
   * The worktree may hold nested repositories — projects cloned into the
   * workspace, each with its own git. The panel shows their changes with the
   * project directory as a path prefix, so a discard must route each path to
   * the repository that owns it, and a discard-everything must clear each
   * repository's own uncommitted work. What it must never do is delete a
   * nested repository itself: the dialog promises that anything committed
   * stays, and the repository's commits are exactly that. (`git clean -fd`
   * agrees — it refuses untracked nested repositories without a second -f.)
   */
  const roots = await discoverNestedRepos(sandbox, cwd);

  const headKnown = new Map<string, boolean>();
  async function hasHeadIn(dir: string): Promise<boolean> {
    const known = headKnown.get(dir);
    if (known !== undefined) {
      return known;
    }
    const result = await sandbox.exec(
      "git rev-parse --verify HEAD",
      dir,
      10000,
    );
    headKnown.set(dir, result.success);
    return result.success;
  }

  async function discardEverythingIn(dir: string): Promise<void> {
    if (await hasHeadIn(dir)) {
      const resetResult = await sandbox.exec(
        "git reset --hard HEAD",
        dir,
        30000,
      );
      if (!resetResult.success) {
        logGitFailure("reset --hard", resetResult);
        throw new Error(DISCARD_FAILED);
      }
    } else {
      const clearIndexResult = await sandbox.exec(
        "git rm -rf --cached .",
        dir,
        30000,
      );
      if (
        !clearIndexResult.success &&
        !isPathspecError(toGitOutput(clearIndexResult))
      ) {
        logGitFailure("rm --cached", clearIndexResult);
        throw new Error(DISCARD_FAILED);
      }
    }

    const cleanResult = await sandbox.exec("git clean -fd", dir, 30000);
    if (!cleanResult.success) {
      logGitFailure("clean", cleanResult);
      throw new Error(DISCARD_FAILED);
    }
  }

  if (filePath) {
    for (const targetPath of targetPaths) {
      const { root, rel } = ownerOf(targetPath, roots);
      const dir = repoCwd(cwd, root);

      const statusCheck = await ensurePathHasUncommittedChanges({
        cwd: dir,
        path: rel,
        sandbox,
      });
      if (!statusCheck.ok) {
        throw new Error(statusCheck.error);
      }

      const result = await discardPathChanges({
        cwd: dir,
        path: rel,
        hasHead: await hasHeadIn(dir),
        sandbox,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
    }
  } else {
    await discardEverythingIn(cwd);
    for (const root of roots) {
      await discardEverythingIn(repoCwd(cwd, root));
    }
  }

  let hasUncommittedChanges = false;
  if (filePath) {
    for (const targetPath of targetPaths) {
      const { root, rel } = ownerOf(targetPath, roots);
      const statusResult = await sandbox.exec(
        `git status --porcelain -- ${shellQuote(rel)}`,
        repoCwd(cwd, root),
        10000,
      );
      if (!statusResult.success) {
        logGitFailure("status", statusResult);
        throw new Error(DISCARD_CHECK_FAILED);
      }
      hasUncommittedChanges ||= statusResult.stdout.trim().length > 0;
    }
  } else {
    for (const root of ["", ...roots]) {
      const statusResult = await sandbox.exec(
        "git status --porcelain",
        repoCwd(cwd, root),
        10000,
      );
      if (!statusResult.success) {
        logGitFailure("status", statusResult);
        throw new Error(DISCARD_CHECK_FAILED);
      }
      // A repository's view of a repository nested inside it (`?? project/`)
      // is not an uncommitted change — the panel does not show it, and no
      // discard can ever clear it. Everything else counts.
      const within = rootsWithin(root, roots);
      const dirty = statusResult.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .some((line) => !isNestedRepoRootRow(line.slice(3).trim(), within));
      hasUncommittedChanges ||= dirty;
    }
  }

  return {
    discarded: true,
    hasUncommittedChanges,
  };
}
