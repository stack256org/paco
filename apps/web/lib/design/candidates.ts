import "server-only";

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { assertPathSegment, chatDir, repoDir } from "@paco/sandbox";

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

/** The branch a design candidate works on: `design/<chatId>/<n>`. */
function designBranch(chatId: string, index: number): string {
  return `design/${assertPathSegment(chatId)}/${index}`;
}

/** The prefix shared by every design-candidate branch for one chat. */
function designBranchPrefix(chatId: string): string {
  return `design/${assertPathSegment(chatId)}/`;
}

/** A design candidate's worktree, as an absolute path under the workspace root. */
function designWorktreeDir(
  sessionWorkspace: string,
  chatId: string,
  index: number,
): string {
  return path.posix.join(
    sessionWorkspace,
    DESIGNS_DIRNAME,
    assertPathSegment(chatId),
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
 * Re-derive nginx's preview routing after this chat's candidate worktrees
 * changed on disk.
 *
 * nginx has no equivalent of Traefik's Docker-label auto-discovery, so
 * `syncPreviewRoutes` (`lib/preview/nginx-reload.ts`) is the whole routing
 * table — and it detects a candidate purely by `designs/<chatId>/<n>/`
 * existing. Creating and removing those directories is what this module
 * does, which makes it the one place that knows the routing input changed.
 * Before this call existed, `syncPreviewRoutes` had a single production
 * caller — cold sandbox provisioning — which necessarily runs *before* any
 * candidate worktree exists, so no candidate route was ever written: every
 * candidate iframe 404'd, the click-inspector `sub_filter` (injected only by
 * the candidate server block) never ran, and with no annotations possible
 * the Iterate button stayed disabled forever.
 *
 * Best-effort by construction. A host with no nginx (local dev, CI, a Docker
 * Compose deployment) or a transient `sudo`/`nginx -t` failure must never be
 * the reason a design turn fails or a chat cannot be deleted — the periodic
 * reconciliation (`lib/preview/reconcile-job.ts`) re-runs the same
 * derivation on its own schedule and will pick the change up regardless.
 *
 * Imported lazily so this module's own tests — and every caller that only
 * wants the git lifecycle — do not pull a Postgres client and the instance
 * settings in through `nginx-reload.ts`'s import graph.
 */
/**
 * Free the ports this chat's candidate dev servers are holding.
 *
 * A candidate's dev server is started by the candidate's own agent turn and
 * nothing in Paco has ever held a handle on it, so removing the worktree used
 * to leave the process alive and the port occupied for the rest of the
 * container's life — which then stopped the *next* design turn's candidate
 * from binding it at all. Both mutating paths in this module therefore ask
 * for the ports back: before the worktrees go away, and before fresh ones
 * take their place.
 *
 * `stopCandidateDevServers` only ever kills a process whose working directory
 * is inside this workspace's `designs/` tree, which is what keeps it from
 * touching the chat's own dev server — those candidate ports are ordinary
 * published ports the chat may legitimately be using. Lazily imported and
 * fully best-effort for the same reasons as the route sync above.
 */
async function stopCandidateDevServersBestEffort(
  chatId: string,
  indexes: readonly (1 | 2 | 3)[],
): Promise<void> {
  try {
    const { stopCandidateDevServersForChat } =
      await import("@/lib/preview/candidate-dev-server");
    await stopCandidateDevServersForChat({ chatId, indexes });
  } catch (error) {
    console.error(
      `Failed to reclaim design candidate ports for chat ${chatId}:`,
      error,
    );
  }
}

async function syncPreviewRoutesBestEffort(reason: string): Promise<void> {
  try {
    const { syncPreviewRoutes } = await import("@/lib/preview/nginx-reload");
    await syncPreviewRoutes();
  } catch (error) {
    console.error(
      `Failed to sync preview nginx routes after ${reason}:`,
      error,
    );
  }
}

/**
 * Remove one candidate's worktree and branch, tolerating every way it could
 * already be gone (or never have been a proper worktree at all).
 *
 * Shared by `removeCandidates` (routine cleanup) and `createCandidates`
 * (self-healing a stale candidate before recreating it): both need "make
 * sure index `n` is gone" rather than "assume it was created correctly last
 * time."
 *
 * `git worktree remove` only handles a directory git actually registered.
 * An aborted earlier run can leave a directory behind that was never
 * registered (or whose registration was already pruned), and `worktree add`
 * refuses to reuse a non-empty target — so this also removes the directory
 * directly, best-effort, after asking git.
 */
async function removeCandidateAt(params: {
  sessionWorkspace: string;
  chatId: string;
  index: number;
  repo: string;
}): Promise<void> {
  const { sessionWorkspace, chatId, index, repo } = params;
  const worktreeDir = designWorktreeDir(sessionWorkspace, chatId, index);

  await git(["worktree", "remove", "--force", worktreeDir], repo);
  await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {
    // Best-effort: if this fails, the `worktree add` below will surface it.
  });
  await git(["branch", "-D", designBranch(chatId, index)], repo);
}

/**
 * Create `count` candidate worktrees, each on its own `design/<chatId>/<n>`
 * branch, branched from `baseBranch` (the chat's own branch).
 *
 * Self-heals a stale candidate first: an earlier run that was aborted
 * partway through can leave a `design/<chatId>/<n>` branch, worktree
 * directory, or both, behind at the same path/name a fresh run needs — so
 * each index is cleared with the same logic `removeCandidates` uses before
 * `worktree add` runs.
 *
 * Not transactional beyond that: if one candidate fails partway through,
 * the ones already created are left in place rather than rolled back — call
 * `removeCandidates` to clean up, which tolerates that half-created state.
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

  // An earlier turn's dev server still holding candidate n's port would make
  // this run's candidate n unreachable — the worktree would exist, nginx
  // would route to the port, and the wrong (or a dead) app would answer.
  const indexes = ALL_CANDIDATE_INDICES.filter((index) => index <= count);
  await stopCandidateDevServersBestEffort(chatId, indexes);

  const candidates: DesignCandidate[] = [];
  for (let i = 1; i <= count; i++) {
    const index = i as 1 | 2 | 3;
    const branch = designBranch(chatId, index);
    const worktreeDir = designWorktreeDir(sessionWorkspace, chatId, index);

    await removeCandidateAt({ sessionWorkspace, chatId, index, repo });

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

  // After the loop, never inside it: a route is only written for a candidate
  // whose directory is already on disk, so one sync at the end covers every
  // candidate this call created rather than racing each one.
  await syncPreviewRoutesBestEffort(`creating design candidates for ${chatId}`);

  return candidates;
}

/**
 * Remove every design-candidate worktree and branch for a chat.
 *
 * Idempotent and safe when none exist: pruning and branch listing are no-ops
 * on a chat with no candidates, and removing a candidate whose directory was
 * deleted by hand (without `git worktree remove`) is one of the cases
 * `removeCandidateAt` tolerates directly.
 *
 * Iterates every index a candidate could ever have (1..3) and asks git to
 * remove each one directly, rather than discovering candidates by matching
 * paths against `git worktree list` output: git resolves a worktree's
 * absolute path (e.g. through a symlinked temp dir) when it registers it, so
 * a string comparison against the path as constructed here can miss a real
 * match. Passing the same path straight to `worktree remove` does not have
 * that problem — git resolves it the same way on the way in.
 *
 * The trailing `branch --list` sweep is a safety net for any
 * `design/<chatId>/*` branch not covered by the fixed index range above
 * (there should not be one, since candidates never go beyond index 3, but a
 * branch is cheap to double-check for and expensive to leak).
 */
export async function removeCandidates(params: {
  sessionWorkspace: string;
  chatId: string;
}): Promise<void> {
  const { sessionWorkspace, chatId } = params;
  const repo = repoDir(sessionWorkspace);

  // First, while the worktrees are still on disk: a dev server outlives its
  // worktree otherwise, holding 5173/4321/8000 until the container stops.
  await stopCandidateDevServersBestEffort(chatId, ALL_CANDIDATE_INDICES);

  // Drops the registration for any candidate whose directory has already
  // been deleted out from under git, so a half-removed candidate does not
  // block the loop below.
  await git(["worktree", "prune"], repo);

  for (const index of ALL_CANDIDATE_INDICES) {
    await removeCandidateAt({ sessionWorkspace, chatId, index, repo });
  }
  await git(["worktree", "prune"], repo);

  const branchList = await git(
    ["branch", "--list", `${designBranchPrefix(chatId)}*`],
    repo,
  );
  if (branchList.success) {
    const branches = branchList.stdout
      .split("\n")
      // `git branch --list` prefixes the checked-out branch with `*` and a
      // branch checked out in another worktree with `+`; neither is part of
      // the name.
      .map((line) => line.replace(/^[*+]?\s*/, "").trim())
      .filter(Boolean);

    for (const branch of branches) {
      await git(["branch", "-D", branch], repo);
    }
  }

  // The worktrees are gone, so their `paco-preview-<slug>-d<n>.conf` files
  // are now stale config pointing at a dead upstream. `syncPreviewRoutes`
  // removes every `paco-preview-*.conf` it did not regenerate, so this one
  // call is also the cleanup.
  await syncPreviewRoutesBestEffort(`removing design candidates for ${chatId}`);
}

/** One candidate worktree found on disk, with the chat it belongs to. */
export interface CandidateWorktreeOnDisk {
  chatId: string;
  index: 1 | 2 | 3;
  worktreeDir: string;
}

/**
 * Every candidate worktree currently under a workspace's `designs/`, across
 * all of its chats.
 *
 * Nothing used to be able to answer this. A process death inside the design
 * step leaves candidate worktrees and branches behind, and the reaping
 * subsystem classifies whole *workspaces* against the `sessions` table — a
 * granularity at which a stray `designs/<chatId>/2/` inside a perfectly live
 * workspace is invisible. `cleanupOrphanedCandidates` in the chat workflow
 * only ever runs when the failure happened in-process, so the one case that
 * actually loses the handle — the process going away — was the one case
 * nothing covered.
 *
 * Directory presence is the signal, matching `createCandidates` /
 * `removeCandidates` and `collectActivePreviewRoutes`'s own detection. Reads
 * only; deciding what an orphan is needs the database and belongs to the
 * caller (`lib/preview/reconcile-job.ts`).
 */
export async function listCandidateWorktrees(
  sessionWorkspace: string,
): Promise<CandidateWorktreeOnDisk[]> {
  const designsRoot = path.posix.join(sessionWorkspace, DESIGNS_DIRNAME);

  let chatDirs: string[];
  try {
    const entries = await fs.readdir(designsRoot, { withFileTypes: true });
    chatDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No `designs/` at all: a workspace that has never run a design turn.
    return [];
  }

  const found: CandidateWorktreeOnDisk[] = [];
  for (const chatId of chatDirs) {
    for (const index of ALL_CANDIDATE_INDICES) {
      const worktreeDir = path.posix.join(designsRoot, chatId, String(index));
      try {
        const stats = await fs.stat(worktreeDir);
        if (stats.isDirectory()) {
          found.push({ chatId, index, worktreeDir });
        }
      } catch {
        // Not created, or already removed.
      }
    }
  }

  return found;
}

/**
 * The candidate at `index`, if its worktree is still on disk — `null`
 * otherwise.
 *
 * This is what iterating on a candidate needs: refining candidate 2 means
 * running the designer again in candidate 2's *existing* worktree, so it
 * needs that candidate's branch and directory without going anywhere near
 * `createCandidates`, which deliberately destroys and recreates every
 * candidate from the chat's branch.
 *
 * The directory is checked rather than assumed, because the names are pure
 * functions of the chat id: a `DesignCandidate` can always be *described*,
 * whether or not one was ever created. Returning `null` lets the caller say
 * "that candidate is gone" instead of starting an agent turn in a directory
 * that does not exist.
 */
export async function resolveCandidate(params: {
  sessionWorkspace: string;
  chatId: string;
  index: 1 | 2 | 3;
}): Promise<DesignCandidate | null> {
  const { sessionWorkspace, chatId, index } = params;
  const worktreeDir = designWorktreeDir(sessionWorkspace, chatId, index);

  try {
    const stats = await fs.stat(worktreeDir);
    if (!stats.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  return { index, branch: designBranch(chatId, index), worktreeDir };
}

/**
 * Merge one design candidate's branch into the chat's branch, inside the
 * chat's own worktree, then remove every candidate worktree and branch.
 *
 * Refuses when the chat's worktree has uncommitted changes: merging on top
 * of them would mix the candidate's commit with whatever was already there,
 * uncommitted and unreviewed. Git itself refuses too, for the same reason —
 * a merge that would overwrite a local modification is aborted — so this is
 * not a policy layered over git so much as git's own rule, checked early
 * enough to say something useful about it.
 *
 * Since turns stopped committing, a dirty chat worktree is the *normal* state
 * rather than the exception, so the refusal has to name the remedy the person
 * actually has: the Source Control panel. The host path it used to print told
 * whoever pressed the button nothing they could act on.
 *
 * A merge conflict also refuses: the merge is aborted, leaving the chat
 * worktree clean and still on `chatBranch`, and candidates are deliberately
 * NOT removed — the user needs them (or their diff) to retry or resolve by
 * hand, so cleanup only happens once a merge actually lands.
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
      error:
        "This chat has uncommitted changes, and adopting a candidate merges a branch on top of them. Commit or discard them in the Source Control panel, then adopt the candidate.",
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
    // Best-effort: leaves a clean worktree, still on chatBranch, behind
    // rather than a conflicted merge the caller never asked for. Candidates
    // are left in place (no `removeCandidates` call) so the user can retry
    // or inspect the conflict.
    await git(["merge", "--abort"], chatWorktree);
    return {
      ok: false,
      error: `Failed to merge design candidate ${index} into ${chatBranch}: ${gitOutput(merge)}`,
    };
  }

  await removeCandidates({ sessionWorkspace, chatId });
  return { ok: true };
}
