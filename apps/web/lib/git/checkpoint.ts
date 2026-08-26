import "server-only";

import type { Sandbox } from "@paco/sandbox";

/**
 * A restore point for one agent turn.
 *
 * The agent edits files directly, and a turn can touch dozens of them. Undo in
 * an editor does not help — the changes never went through one — so the only
 * honest "put it back" is a git state to return to.
 *
 * Two are taken per turn: one *before* it runs (`createCheckpoint`), which is
 * what "undo this turn" returns to, and one *after* it finishes
 * (`snapshotTurn`), which records what the turn produced.
 *
 * Both matter far more than they used to. Turns no longer commit — the human
 * commits, explicitly — so nothing on the branch keeps a turn's state
 * reachable. A snapshot object with no ref pointing at it is unreferenced and
 * `gc` is entitled to delete it, which is why every snapshot gets a ref of its
 * own under `refs/paco/turns/<chatId>/` rather than sharing one ref per chat
 * that each turn overwrote.
 *
 * Three properties hold for every snapshot, and they are the whole design:
 *
 * 1. **Invisible.** It lives outside `refs/heads`, and it is a *child* of HEAD
 *    rather than an ancestor, so it appears in no branch's `git log`, in no
 *    `origin/base...HEAD` diff, and in nothing the Changes list reads. Git's
 *    default push refspec covers `refs/heads/*`, so it is never published.
 * 2. **Complete.** Untracked files are captured, because a turn that creates a
 *    file and an undo that silently fails to remove or restore it is worse
 *    than no undo at all. Ignored files are deliberately not captured.
 * 3. **Inert.** Taking one does not touch the index or the working tree. The
 *    operator's staging area is a deliberate selection of work; clobbering it
 *    to take a backup would be the single worst thing this module could do.
 */

const CHECKPOINT_TIMEOUT_MS = 60_000;

/**
 * Private ref namespace, outside `refs/heads` so it is never a branch and
 * never matches the default push refspec.
 */
const TURN_REF_PREFIX = "refs/paco/turns";

/**
 * Subject line that marks a commit as one of ours.
 *
 * `restoreCheckpoint` reads the snapshot's second parent to recover the
 * staging area, and a second parent means something entirely different on an
 * ordinary merge commit. A checkpoint for a clean tree *is* the branch's HEAD,
 * which may well be a merge, so "does this commit have a `^2`" is not a safe
 * question to ask. This is.
 */
const SNAPSHOT_SUBJECT = "paco snapshot";

/** How many turn refs to keep per chat before the oldest are dropped. */
const MAX_TURN_REFS_PER_CHAT = 200;

export type Checkpoint = {
  /** Commit object holding the captured tree. */
  sha: string;
  /** Whether the tree had uncommitted work at the time. */
  dirty: boolean;
};

async function git(
  sandbox: Sandbox,
  command: string,
  cwd: string,
): Promise<{ ok: boolean; out: string }> {
  const result = await sandbox.exec(command, cwd, CHECKPOINT_TIMEOUT_MS);
  return { ok: result.success, out: (result.stdout || result.stderr).trim() };
}

/** Chat ids are nanoids/uuids, so this is belt-and-braces for the ref path. */
function refComponent(value: string): string {
  return value.replace(/[^\w.-]/g, "_");
}

function turnRef(chatId: string, leaf: string): string {
  return `${TURN_REF_PREFIX}/${refComponent(chatId)}/${refComponent(leaf)}`;
}

/**
 * Build the commit object that holds a snapshot, without touching anything.
 *
 * The tree comes from a *scratch* index. `GIT_INDEX_FILE` points git at a
 * throwaway file for these commands only, so `add -A` stages into that and the
 * repository's own index — and therefore what `git status` reports to the
 * Changes list — is untouched. `commit-tree` then writes a commit without
 * moving HEAD.
 *
 * `git add -A` rather than `git stash create`: `add -A` is the only one of the
 * two that is purely additive. `stash create` reads and re-derives from the
 * real index, needs `--include-untracked` to see new files at all, and refuses
 * outright mid-merge or mid-rebase — states an agent turn can genuinely leave
 * behind. It also takes `index.lock`, so a snapshot could collide with the
 * operator staging a file at that moment. A scratch index takes no lock and
 * has no opinion about repository state.
 *
 * The scratch files go in the *real* git directory, which is asked for rather
 * than assumed to be `<cwd>/.git`: a chat runs in a linked worktree, where
 * `.git` is a *file* pointing at `<repo>/.git/worktrees/<chat>`.
 * `--absolute-git-dir` rather than `--git-dir`, because the latter answers
 * `.git` relative to the caller and git resolves `GIT_INDEX_FILE` against
 * whatever directory the command ends up running in.
 *
 * The staging area is preserved as a second parent, the way `git stash` does
 * it: a commit whose tree is the *index* tree, copied out of the real index
 * file so that reading it cannot disturb it (`git write-tree` on a live index
 * rewrites its cache-tree extension and takes a lock to do it). Restoring can
 * then put back not just the files but which of them were staged.
 */
async function buildSnapshotCommit(
  sandbox: Sandbox,
  cwd: string,
  head: string,
): Promise<string | null> {
  const gitDir = await git(sandbox, "git rev-parse --absolute-git-dir", cwd);
  if (!(gitDir.ok && gitDir.out)) {
    return null;
  }

  const unique = crypto.randomUUID();
  const worktreeIndex = `${gitDir.out}/paco-snapshot-${unique}.worktree`;
  const indexCopy = `${gitDir.out}/paco-snapshot-${unique}.index`;
  const worktreeEnv = `GIT_INDEX_FILE=${JSON.stringify(worktreeIndex)}`;
  const indexEnv = `GIT_INDEX_FILE=${JSON.stringify(indexCopy)}`;

  const cleanup = () =>
    git(
      sandbox,
      `rm -f ${JSON.stringify(worktreeIndex)} ${JSON.stringify(indexCopy)}`,
      cwd,
    );

  const staged = await git(
    sandbox,
    `${worktreeEnv} git read-tree HEAD && ${worktreeEnv} git add -A`,
    cwd,
  );
  if (!staged.ok) {
    await cleanup();
    return null;
  }

  const worktreeTree = await git(sandbox, `${worktreeEnv} git write-tree`, cwd);
  if (!(worktreeTree.ok && worktreeTree.out)) {
    await cleanup();
    return null;
  }

  // A repository that has never had anything staged has no index file at all;
  // copying it fails and the snapshot simply carries no staging area, which is
  // the truth in that case.
  const copied = await git(
    sandbox,
    `cp -f ${JSON.stringify(`${gitDir.out}/index`)} ${JSON.stringify(indexCopy)}`,
    cwd,
  );

  let indexParent = "";
  if (copied.ok) {
    const indexTree = await git(sandbox, `${indexEnv} git write-tree`, cwd);
    if (indexTree.ok && indexTree.out) {
      const indexCommit = await git(
        sandbox,
        `git commit-tree ${indexTree.out} -p ${head} -m ${JSON.stringify(`${SNAPSHOT_SUBJECT} index`)}`,
        cwd,
      );
      if (indexCommit.ok && indexCommit.out) {
        indexParent = ` -p ${indexCommit.out}`;
      }
    }
  }

  const commit = await git(
    sandbox,
    `git commit-tree ${worktreeTree.out} -p ${head}${indexParent} -m ${JSON.stringify(SNAPSHOT_SUBJECT)}`,
    cwd,
  );

  await cleanup();

  return commit.ok && commit.out ? commit.out : null;
}

/**
 * Drop the oldest turn refs for a chat.
 *
 * Refs are cheap but not free, and one per turn per chat grows without bound
 * over the life of a workspace. Best-effort: a chat that keeps every ref is a
 * tidiness problem, and a failure here must never cost the caller its
 * snapshot.
 */
async function pruneTurnRefs(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
): Promise<void> {
  const namespace = `${TURN_REF_PREFIX}/${refComponent(chatId)}/`;
  await git(
    sandbox,
    `git for-each-ref --sort=-committerdate --format='%(refname)' ${namespace} | tail -n +${MAX_TURN_REFS_PER_CHAT + 1} | while read -r ref; do git update-ref -d "$ref"; done`,
    cwd,
  );
}

async function recordSnapshot(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
  leaf: string,
  sha: string,
): Promise<void> {
  // A ref keeps the commit alive. Without one the object is unreferenced, and
  // since no turn commits any more there is nothing else holding it.
  await git(sandbox, `git update-ref ${turnRef(chatId, leaf)} ${sha}`, cwd);
  await pruneTurnRefs(sandbox, cwd, chatId);
}

async function snapshot(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
  leaf: string | null,
): Promise<Checkpoint | null> {
  const head = await git(sandbox, "git rev-parse HEAD", cwd);
  if (!head.ok) {
    return null;
  }

  const status = await git(sandbox, "git status --porcelain", cwd);
  if (!status.ok) {
    return null;
  }

  if (status.out.length === 0) {
    // A clean tree is already its own restore point, and HEAD is reachable
    // from the branch, so it needs no ref of its own.
    return { sha: head.out, dirty: false };
  }

  const commit = await buildSnapshotCommit(sandbox, cwd, head.out);
  if (!commit) {
    return null;
  }

  await recordSnapshot(sandbox, cwd, chatId, leaf ?? commit, commit);

  return { sha: commit, dirty: true };
}

/**
 * Capture the worktree so the turn about to run can be undone.
 *
 * Returns null when there is nothing to check point against — a repository
 * with no commits yet, or a directory that is not one. The turn still runs; it
 * just gets no revert control.
 *
 * The ref is named after the snapshot commit rather than the turn, because the
 * turn does not have an id yet: this runs before the agent starts and the id
 * comes from the recorder inside it. Naming it after the commit still gives
 * every checkpoint its own ref, which is the property that matters.
 */
export async function createCheckpoint(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
): Promise<Checkpoint | null> {
  return snapshot(sandbox, cwd, chatId, null);
}

/**
 * Record what a finished turn produced, under `refs/paco/turns/<chat>/<turn>`.
 *
 * Not a restore point for undoing *this* turn — that is the checkpoint taken
 * before it. This exists so a turn's result survives even though nothing
 * commits it: without it, the only record of a turn's output is the working
 * tree itself, and the next turn overwrites that.
 */
export async function snapshotTurn(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
  turnId: string,
): Promise<Checkpoint | null> {
  return snapshot(sandbox, cwd, chatId, turnId);
}

export type RestoreResult =
  | { ok: true }
  | { ok: false; reason: "unknown-checkpoint" | "failed"; message: string };

/**
 * Return the worktree to a snapshot, discarding everything after it.
 *
 * Destructive by definition, so callers confirm first. Precisely, this
 * discards:
 *
 * - every change the turn being undone made, which is the point;
 * - every change made *after* it — later turns, and anything the operator
 *   edited by hand — because the snapshot describes a whole tree, not a diff,
 *   and there is no honest way to lift one turn out of the middle of a stack
 *   of edits to the same files;
 * - the current staging area, replaced by the one the snapshot recorded.
 *
 * It does *not* touch commits. The branch does not move, so anything the
 * operator has already committed survives an undo untouched — that is the
 * whole reason committing is now an explicit act.
 *
 * Restores the *tree* without moving HEAD. The snapshot is a child of whatever
 * HEAD was, so resetting onto it would leave the branch pointing at a commit
 * Paco invented and the operator never wrote. `read-tree -u --reset` puts the
 * files and the index back and leaves the branch alone, so work that was
 * uncommitted before the turn is uncommitted again afterwards.
 */
export async function restoreCheckpoint(
  sandbox: Sandbox,
  cwd: string,
  sha: string,
): Promise<RestoreResult> {
  const exists = await git(sandbox, `git cat-file -e ${sha}^{commit}`, cwd);
  if (!exists.ok) {
    return {
      ok: false,
      reason: "unknown-checkpoint",
      message:
        "That checkpoint is no longer in this worktree. It may have been removed by a rebase or a branch change.",
    };
  }

  const subject = await git(sandbox, `git log -1 --format=%s ${sha}`, cwd);
  const isPacoSnapshot = subject.ok && subject.out === SNAPSHOT_SUBJECT;

  const restore = await git(sandbox, `git read-tree -u --reset ${sha}`, cwd);
  if (!restore.ok) {
    return { ok: false, reason: "failed", message: restore.out };
  }

  // Files the turn created are untracked in the restored index, so they
  // survive the read-tree and would leave the revert looking half-applied.
  // No `-x`: ignored files were never captured, so removing them here would
  // delete build output and dependencies the snapshot cannot put back.
  const clean = await git(sandbox, "git clean -fd", cwd);
  if (!clean.ok) {
    return { ok: false, reason: "failed", message: clean.out };
  }

  if (isPacoSnapshot) {
    // Second parent holds the staging area as it stood. Putting it back
    // without `-u` sets the index alone: the working tree keeps the files the
    // reset above just restored, and what was staged is staged again.
    const indexTree = await git(
      sandbox,
      `git rev-parse -q --verify ${sha}^2^{tree}`,
      cwd,
    );
    if (indexTree.ok && indexTree.out) {
      await git(sandbox, `git read-tree ${indexTree.out}`, cwd);
    }
  }

  return { ok: true };
}
