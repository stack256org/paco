import "server-only";

import type { Sandbox } from "@paco/sandbox";

/**
 * A restore point taken before an agent turn.
 *
 * The agent edits files directly, and a turn can touch dozens of them. Undo in
 * an editor does not help — the changes never went through one — so the only
 * honest "put it back" is a git state to return to.
 *
 * Taken *before* the turn rather than after, because after is too late: by the
 * time the turn ends the previous state is only recoverable if something
 * recorded it first.
 *
 * The important constraint is that taking one must not disturb anything. The
 * first version committed the working tree, which meant the checkpoint before
 * turn N+1 swallowed everything turn N had produced: the Changes tab went
 * empty, and the user's actual work ended up inside a commit called "paco:
 * checkpoint" that they never wrote. A checkpoint now writes a commit *object*
 * built from a scratch index and stores it under a private ref, leaving the
 * index, the working tree and the branch exactly as they were.
 */

const CHECKPOINT_TIMEOUT_MS = 60_000;

/** Private ref namespace. Outside refs/heads, so it never appears as a branch. */
const CHECKPOINT_REF_PREFIX = "refs/paco/checkpoints";

export type Checkpoint = {
  /** Commit object holding the pre-turn tree. */
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

function checkpointRef(chatId: string): string {
  // Chat ids are nanoids/uuids, so they are already safe as a ref component.
  return `${CHECKPOINT_REF_PREFIX}/${chatId.replace(/[^\w.-]/g, "_")}`;
}

/**
 * Capture the worktree so the turn about to run can be undone.
 *
 * Returns null when there is nothing to check point against — a repository with
 * no commits yet, or a directory that is not one. The turn still runs; it just
 * gets no revert control.
 */
export async function createCheckpoint(
  sandbox: Sandbox,
  cwd: string,
  chatId: string,
): Promise<Checkpoint | null> {
  const head = await git(sandbox, "git rev-parse HEAD", cwd);
  if (!head.ok) {
    return null;
  }

  const status = await git(sandbox, "git status --porcelain", cwd);
  if (!status.ok) {
    return null;
  }

  const dirty = status.out.length > 0;

  if (!dirty) {
    // A clean tree is already its own restore point.
    return { sha: head.out, dirty: false };
  }

  /*
   * Build the tree through a scratch index rather than the real one.
   *
   * `GIT_INDEX_FILE` points git at a throwaway index for these commands only,
   * so `add -A` stages into that file and the repository's own index — and
   * therefore what `git status` reports to the Changes tab — is untouched.
   * `commit-tree` then writes a commit object without moving HEAD.
   *
   * The scratch index goes in the *real* git directory, which is asked for
   * rather than assumed to be `<cwd>/.git`. A chat runs in a linked worktree,
   * where `.git` is a file pointing at `<repo>/.git/worktrees/<chat>` — so
   * writing there failed with "Not a directory", every command in this block
   * failed, and `createCheckpoint` returned null. Only the clean-tree early
   * return above still worked, which is why the first turn of a chat could be
   * reverted and no turn after it could.
   *
   * `--absolute-git-dir` rather than `--git-dir`: the latter answers `.git`
   * relative to the caller, and git resolves `GIT_INDEX_FILE` against whatever
   * directory the command ends up running in, not against `cwd`.
   */
  const gitDir = await git(sandbox, "git rev-parse --absolute-git-dir", cwd);
  if (!gitDir.ok || !gitDir.out) {
    return null;
  }

  const scratchIndex = `${gitDir.out}/paco-checkpoint-index`;
  const env = `GIT_INDEX_FILE=${JSON.stringify(scratchIndex)}`;

  const staged = await git(
    sandbox,
    `${env} git read-tree HEAD && ${env} git add -A`,
    cwd,
  );
  if (!staged.ok) {
    return null;
  }

  const tree = await git(sandbox, `${env} git write-tree`, cwd);
  if (!tree.ok || !tree.out) {
    return null;
  }

  const commit = await git(
    sandbox,
    `git commit-tree ${tree.out} -p ${head.out} -m "paco checkpoint"`,
    cwd,
  );
  if (!commit.ok || !commit.out) {
    return null;
  }

  // A ref keeps the commit alive; an unreferenced object would be collected.
  await git(
    sandbox,
    `git update-ref ${checkpointRef(chatId)} ${commit.out}`,
    cwd,
  );
  await git(sandbox, `rm -f ${JSON.stringify(scratchIndex)}`, cwd);

  return { sha: commit.out, dirty: true };
}

export type RestoreResult =
  | { ok: true }
  | { ok: false; reason: "unknown-checkpoint" | "failed"; message: string };

/**
 * Return the worktree to a checkpoint, discarding everything after it.
 *
 * Destructive by definition, so callers confirm first.
 *
 * Restores the *tree* without moving HEAD. The checkpoint commit is a child of
 * whatever HEAD was, so resetting onto it would leave the branch pointing at a
 * commit Paco invented. `read-tree -u --reset` puts the files and the index
 * back exactly as they were and leaves the branch alone — so work that was
 * uncommitted before the turn is uncommitted again afterwards, which is what
 * "put it back" has to mean.
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

  const restore = await git(sandbox, `git read-tree -u --reset ${sha}`, cwd);
  if (!restore.ok) {
    return { ok: false, reason: "failed", message: restore.out };
  }

  // Files the turn created are untracked in the restored index, so they survive
  // the read-tree and would leave the revert looking half-applied.
  const clean = await git(sandbox, "git clean -fd", cwd);
  if (!clean.ok) {
    return { ok: false, reason: "failed", message: clean.out };
  }

  return { ok: true };
}
