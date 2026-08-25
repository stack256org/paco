import "server-only";

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { chatDir, repoDir } from "@paco/sandbox";

const execFileAsync = promisify(execFile);

/**
 * One candidate screen in a design turn: its own branch and worktree,
 * created from the chat's branch.
 *
 * Siblings of `chats/<chatId>/` under the session workspace, per the
 * workspace layout doc — a worktree's `.git` is a pointer file back into
 * `repo/.git/worktrees/<id>`, so every worktree (chat or candidate) has to
 * live under the same mount as `repo/`.
 */
export interface DesignCandidate {
  index: 1 | 2 | 3;
  branch: string;
  worktreeDir: string;
}

/** Directory holding design-candidate worktrees, relative to the workspace root. */
const DESIGNS_DIRNAME = "designs";

/** Same shape as the chat-id guard in `packages/sandbox/docker/layout.ts`. */
const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Reject anything that could escape the workspace when used as a path
 * segment. Chat ids are generated, so this should never fire.
 */
function assertChatId(chatId: string): string {
  if (!CHAT_ID_PATTERN.test(chatId)) {
    throw new Error(`Unsafe chat id for a path segment: ${chatId}`);
  }
  return chatId;
}

/** The branch a design candidate works on: `design/<chatId>/<n>`. */
function designBranch(chatId: string, index: number): string {
  return `design/${assertChatId(chatId)}/${index}`;
}

/** The prefix shared by every design-candidate branch for one chat. */
function designBranchPrefix(chatId: string): string {
  return `design/${assertChatId(chatId)}/`;
}

/** A design candidate's worktree, as an absolute path under the workspace root. */
function designWorktreeDir(
  sessionWorkspace: string,
  chatId: string,
  index: number,
): string {
  return path.join(
    sessionWorkspace,
    DESIGNS_DIRNAME,
    assertChatId(chatId),
    String(index),
  );
}

/**
 * Candidate indices ever handed out, per the branch-naming rule
 * `design/<chatId>/<n>` (n = 1..3) — the upper bound `createCandidates`
 * itself enforces via `count: 2 | 3`.
 */
const ALL_CANDIDATE_INDICES = [1, 2, 3] as const;

interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run one git command directly on the host filesystem.
 *
 * `sessionWorkspace` is the same absolute path on the host and inside the
 * sandbox container (the workspace is mounted twice, at the same source —
 * see `docs/agents/architecture.md`), so candidate worktrees can be managed
 * from here without going through a `Sandbox`. Arguments go through
 * `execFile`'s argv array and never a shell, so a branch name or path can't
 * smuggle in a second command.
 */
async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd });
    return { success: true, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string } & Error;
    return {
      success: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

function gitOutput(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || "git command failed";
}

/**
 * Create `count` candidate worktrees, each on its own `design/<chatId>/<n>`
 * branch, branched from `baseBranch` (the chat's own branch).
 *
 * Not transactional: if one candidate fails partway through, the ones
 * already created are left in place rather than rolled back — call
 * `removeCandidates` to clean up, which tolerates exactly that half-created
 * state.
 */
export async function createCandidates(params: {
  sessionWorkspace: string;
  chatId: string;
  baseBranch: string;
  count: 2 | 3;
}): Promise<DesignCandidate[]> {
  const { sessionWorkspace, chatId, baseBranch, count } = params;
  const repo = repoDir(sessionWorkspace);

  // Stale metadata (e.g. a worktree directory removed without git being
  // told) would otherwise block `worktree add`. A no-op in the healthy case.
  await git(["worktree", "prune"], repo);

  const candidates: DesignCandidate[] = [];
  for (let i = 1; i <= count; i++) {
    const index = i as 1 | 2 | 3;
    const branch = designBranch(chatId, index);
    const worktreeDir = designWorktreeDir(sessionWorkspace, chatId, index);

    const result = await git(
      ["worktree", "add", "-b", branch, worktreeDir, baseBranch],
      repo,
    );
    if (!result.success) {
      throw new Error(
        `Failed to create design candidate ${index} worktree: ${gitOutput(result)}`,
      );
    }

    candidates.push({ index, branch, worktreeDir });
  }

  return candidates;
}

/**
 * Remove every design-candidate worktree and branch for a chat.
 *
 * Idempotent and safe when none exist: pruning and branch listing are no-ops
 * on a chat with no candidates, and removing a candidate whose directory was
 * deleted by hand (without `git worktree remove`) is handled by pruning
 * first, which drops git's record of a worktree whose directory is gone —
 * the removal attempt below then simply finds nothing registered there.
 *
 * Iterates every index a candidate could ever have (1..3) and asks git to
 * remove each one directly, rather than discovering candidates by matching
 * paths against `git worktree list` output: git resolves a worktree's
 * absolute path (e.g. through a symlinked temp dir) when it registers it, so
 * a string comparison against the path as constructed here can miss a real
 * match. Passing the same path straight to `worktree remove` does not have
 * that problem — git resolves it the same way on the way in.
 */
export async function removeCandidates(params: {
  sessionWorkspace: string;
  chatId: string;
}): Promise<void> {
  const { sessionWorkspace, chatId } = params;
  const repo = repoDir(sessionWorkspace);

  // Drops the registration for any candidate whose directory has already
  // been deleted out from under git, so a half-removed candidate does not
  // block the loop below.
  await git(["worktree", "prune"], repo);

  for (const index of ALL_CANDIDATE_INDICES) {
    const worktreeDir = designWorktreeDir(sessionWorkspace, chatId, index);
    await git(["worktree", "remove", "--force", worktreeDir], repo);
  }
  await git(["worktree", "prune"], repo);

  const branchList = await git(
    ["branch", "--list", `${designBranchPrefix(chatId)}*`],
    repo,
  );
  if (!branchList.success) {
    return;
  }

  const branches = branchList.stdout
    .split("\n")
    .map((line) => line.replace(/^\*?\s*/, "").trim())
    .filter(Boolean);

  for (const branch of branches) {
    await git(["branch", "-D", branch], repo);
  }
}

/**
 * Merge one design candidate's branch into the chat's branch, inside the
 * chat's own worktree, then remove every candidate worktree and branch.
 *
 * Refuses when the chat's worktree has uncommitted changes: merging on top
 * of them would mix the candidate's commit with whatever was already there,
 * uncommitted and unreviewed.
 */
export async function acceptCandidate(params: {
  sessionWorkspace: string;
  chatId: string;
  index: number;
  chatBranch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sessionWorkspace, chatId, index, chatBranch } = params;
  const chatWorktree = chatDir(sessionWorkspace, chatId);
  const branch = designBranch(chatId, index);

  const status = await git(["status", "--porcelain"], chatWorktree);
  if (!status.success) {
    return {
      ok: false,
      error: `Failed to check the chat worktree at ${chatWorktree}: ${gitOutput(status)}`,
    };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      error: `The chat worktree at ${chatWorktree} has uncommitted changes; commit or discard them before accepting a design candidate.`,
    };
  }

  const currentBranch = await git(
    ["symbolic-ref", "--short", "HEAD"],
    chatWorktree,
  );
  if (currentBranch.success && currentBranch.stdout.trim() !== chatBranch) {
    return {
      ok: false,
      error: `The chat worktree at ${chatWorktree} is on ${currentBranch.stdout.trim() || "a detached HEAD"}, not ${chatBranch}.`,
    };
  }

  const merge = await git(
    ["merge", "--no-ff", "-m", `Adopt design candidate ${index}`, branch],
    chatWorktree,
  );
  if (!merge.success) {
    // Best-effort: leaves a clean worktree behind rather than a conflicted
    // merge the caller never asked for.
    await git(["merge", "--abort"], chatWorktree);
    return {
      ok: false,
      error: `Failed to merge design candidate ${index} into ${chatBranch}: ${gitOutput(merge)}`,
    };
  }

  await removeCandidates({ sessionWorkspace, chatId });
  return { ok: true };
}
