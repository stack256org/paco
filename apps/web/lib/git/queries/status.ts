"use server";

import { connectSandbox } from "@paco/sandbox";
import { resolveWorkCwd } from "@/lib/agent/workspace-paths";
import { getSessionById } from "@/lib/db/sessions";
import { isSafeBranchName } from "@/lib/git/helpers";
import {
  discoverNestedRepos,
  repoCwd,
  rootsWithin,
} from "@/lib/git/nested-repos";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { SESSION_NOT_FOUND, WORKSPACE_NOT_STARTED } from "@/lib/error-copy";

// ---- types ----

export interface SessionGitStatus {
  branch: string;
  isDetachedHead: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  uncommittedFiles: number;
}

// ---- helpers ----

type StatusSets = {
  stagedFiles: Set<string>;
  unstagedFiles: Set<string>;
  untrackedFiles: Set<string>;
};

/**
 * Fold one repository's porcelain output into the running sets.
 *
 * `prefix` is the repository's directory for a nested repository, `""` for
 * the worktree's own — without it, two repositories both touching a
 * `README.md` would collapse into one entry and the counts would lie.
 * `dropPaths` removes the parent's view of a nested repository (the opaque
 * `project/` row, or a gitlink), whose real changes arrive from the
 * repository's own pass.
 */
function collectPorcelainStatus(
  output: string,
  sets: StatusSets,
  prefix = "",
  dropPaths: string[] = [],
): void {
  for (const line of output.trim().split("\n")) {
    if (!line || line.length < 3) continue;

    const indexStatus = line[0];
    const worktreeStatus = line[1];
    const filePath = line.slice(3).trim();
    if (!filePath) continue;

    const bare = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    if (dropPaths.includes(bare)) continue;

    const keyed = prefix ? `${prefix}/${filePath}` : filePath;

    if (indexStatus === "?" && worktreeStatus === "?") {
      sets.untrackedFiles.add(keyed);
      continue;
    }

    if (indexStatus !== " " && indexStatus !== "?") {
      sets.stagedFiles.add(keyed);
    }

    if (worktreeStatus !== " " && worktreeStatus !== "?") {
      sets.unstagedFiles.add(keyed);
    }
  }
}

function countStatusSets(sets: StatusSets): {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  uncommittedFiles: number;
} {
  const uncommitted = new Set<string>([
    ...sets.stagedFiles,
    ...sets.unstagedFiles,
    ...sets.untrackedFiles,
  ]);

  return {
    stagedCount: sets.stagedFiles.size,
    unstagedCount: sets.unstagedFiles.size,
    untrackedCount: sets.untrackedFiles.size,
    uncommittedFiles: uncommitted.size,
  };
}

function parseRemoteRef(output: string): string | null {
  const trimmed = output.trim();
  const match = trimmed.match(/^refs\/remotes\/(.+)$/);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

async function requireSession(sessionId: string) {
  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    throw new Error(SESSION_NOT_FOUND);
  }
  return sessionRecord;
}

// ---- server action ----

export async function getGitStatus(params: {
  sessionId: string;
  /** Report on this chat's worktree; without it, the session's repository. */
  chatId?: string;
}): Promise<SessionGitStatus | null> {
  const { sessionId } = params;

  const sessionRecord = await requireSession(sessionId);

  if (!isSandboxActive(sessionRecord.sandboxState)) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }

  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    throw new Error(WORKSPACE_NOT_STARTED);
  }

  try {
    const sandbox = await connectSandbox(sandboxState);
    const cwd = resolveWorkCwd(sandboxState, params.chatId);

    // get current branch - detect detached HEAD explicitly
    const symbolicRefResult = await sandbox.exec(
      "git symbolic-ref --short HEAD",
      cwd,
      10000,
    );

    let branch: string;
    let isDetachedHead = false;

    if (symbolicRefResult.success && symbolicRefResult.stdout.trim()) {
      branch = symbolicRefResult.stdout.trim();
    } else {
      // detached HEAD - get short commit hash for display
      const revParseResult = await sandbox.exec(
        "git rev-parse --short HEAD",
        cwd,
        10000,
      );
      branch = revParseResult.stdout.trim();
      isDetachedHead = true;
    }

    // Check for uncommitted changes — in this repository, and in every
    // repository nested inside the worktree. A workspace holding several
    // projects is several repositories, and `git status` at the root cannot
    // see inside them; counting only the root left this badge (and everything
    // gated on it, like the commit panel) blind to the nested projects' work.
    const roots = await discoverNestedRepos(sandbox, cwd);
    const sets: StatusSets = {
      stagedFiles: new Set(),
      unstagedFiles: new Set(),
      untrackedFiles: new Set(),
    };

    const statusResult = await sandbox.exec(
      "git status --porcelain",
      cwd,
      10000,
    );
    collectPorcelainStatus(statusResult.stdout, sets, "", roots);

    for (const root of roots) {
      const nestedResult = await sandbox.exec(
        "git status --porcelain",
        repoCwd(cwd, root),
        10000,
      );
      if (nestedResult.success) {
        // An intermediate repository holding a repository of its own has an
        // opaque row for it too — drop it the same way the parent's is.
        collectPorcelainStatus(
          nestedResult.stdout,
          sets,
          root,
          rootsWithin(root, roots),
        );
      }
    }

    const { stagedCount, unstagedCount, untrackedCount, uncommittedFiles } =
      countStatusSets(sets);
    const hasUncommittedChanges = uncommittedFiles > 0;

    // check for commits ahead of upstream or default remote branch
    let hasUnpushedCommits = false;
    const upstreamRefResult = await sandbox.exec(
      "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      cwd,
      10000,
    );

    let aheadBaseRef: string | null = null;
    if (upstreamRefResult.success && upstreamRefResult.stdout.trim()) {
      aheadBaseRef = upstreamRefResult.stdout.trim();
    } else if (!isDetachedHead && isSafeBranchName(branch)) {
      const remoteBranchResult = await sandbox.exec(
        `git rev-parse --verify origin/${branch}`,
        cwd,
        10000,
      );
      if (remoteBranchResult.success && remoteBranchResult.stdout.trim()) {
        aheadBaseRef = `origin/${branch}`;
      }
    }

    if (!aheadBaseRef) {
      const defaultRemoteRefResult = await sandbox.exec(
        "git symbolic-ref refs/remotes/origin/HEAD",
        cwd,
        10000,
      );
      aheadBaseRef = parseRemoteRef(defaultRemoteRefResult.stdout);
    }

    if (aheadBaseRef) {
      const aheadResult = await sandbox.exec(
        `git rev-list ${aheadBaseRef}..HEAD`,
        cwd,
        10000,
      );
      if (aheadResult.success) {
        hasUnpushedCommits = aheadResult.stdout.trim().length > 0;
      }
    }

    return {
      branch,
      isDetachedHead,
      hasUncommittedChanges,
      hasUnpushedCommits,
      stagedCount,
      unstagedCount,
      untrackedCount,
      uncommittedFiles: hasUncommittedChanges ? uncommittedFiles : 0,
    };
  } catch (error) {
    console.error("Failed to get git status:", error);
    return null;
  }
}
