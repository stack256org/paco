import type { DestructiveConfirmRequest } from "@/hooks/destructive-confirm-queue";
import type {
  CommitResult,
  FileChange,
  FileChangeStatus,
  FileDiff,
  SourceControlResult,
  WorkingTreeStatus,
} from "@/lib/git/source-control-types";

/**
 * What the Source Control panel needs on top of the server's own types, and
 * the pure rules that go with it.
 *
 * The data shapes live in `lib/git/source-control-types` and are re-exported
 * here rather than restated, so there is exactly one definition of a
 * `FileChange` and the two halves cannot drift apart. What this file adds is
 * everything the *panel* has to decide: which row is open, what a status
 * letter means once untracked and unmerged both arrive as `U`, why Commit is
 * refusing, and precisely what a Discard destroys.
 *
 * It is separate from the components so those decisions can be tested without
 * rendering anything.
 */

export type {
  CommitResult,
  FileChange,
  FileChangeStatus,
  FileDiff,
  SourceControlResult,
  WorkingTreeStatus,
};

/**
 * The server half, as the panel sees it.
 *
 * Injected rather than imported by the components so tests can drive the whole
 * panel with no sandbox, no worktree, and no git.
 */
export type SourceControlApi = {
  getWorkingTreeStatus: (chatId: string) => Promise<WorkingTreeStatus>;
  stageFiles: (chatId: string, paths: string[]) => Promise<SourceControlResult>;
  unstageFiles: (
    chatId: string,
    paths: string[],
  ) => Promise<SourceControlResult>;
  discardFiles: (
    chatId: string,
    paths: string[],
  ) => Promise<SourceControlResult>;
  commitStaged: (chatId: string, message: string) => Promise<CommitResult>;
  getFileDiff: (
    chatId: string,
    path: string,
    options: { staged: boolean },
  ) => Promise<FileDiff>;
};

/**
 * One row in one of the two lists.
 *
 * `untracked` is not redundant with `status`. Git spends `U` twice: on a file
 * it has never seen, and on a merge conflict. They arrive in different arrays
 * — `untracked` and `unstaged` — and that is the only thing that tells them
 * apart, so the flag has to survive the merge into one flat list. A green `U`
 * meaning "new file" where a red one should say "conflict" is the kind of
 * mistake that gets committed.
 */
export type ChangeRow = FileChange & { untracked: boolean };

/**
 * A row's identity, list included.
 *
 * A file that is staged *and* modified again since staging appears in both
 * lists, and the two rows are different things: one is what the commit would
 * contain, the other is what is still outside it. `staged` is what keeps them
 * apart — in the React key, in the diff request, and in every action the row
 * can start.
 */
export type SelectedFile = { path: string; staged: boolean };

export function fileRowKey(file: SelectedFile): string {
  return `${file.staged ? "staged" : "working"}:${file.path}`;
}

export function isSameFile(
  a: SelectedFile | null,
  b: SelectedFile | null,
): boolean {
  if (!(a && b)) {
    return false;
  }
  return a.path === b.path && a.staged === b.staged;
}

/** What a letter means, spelled out for tooltips and screen readers. */
export function statusLabel(
  status: FileChangeStatus,
  untracked: boolean,
): string {
  if (status === "U") {
    return untracked ? "Untracked" : "Conflicted";
  }
  switch (status) {
    case "M":
      return "Modified";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    default:
      return "Copied";
  }
}

/*
 * Every class name below is a complete literal. Building one by interpolation
 * (`text-${tone}`) compiles away, because Tailwind finds classes by reading the
 * source as text and never runs it.
 */
export function statusToneClass(
  status: FileChangeStatus,
  untracked: boolean,
): string {
  if (status === "U") {
    return untracked ? "text-success" : "text-error";
  }
  switch (status) {
    case "M":
      return "text-warning";
    case "A":
      return "text-success";
    case "D":
      return "text-error";
    default:
      return "text-info";
  }
}

/** The last segment of a path, and everything before it. */
export function splitPath(path: string): {
  fileName: string;
  dirPath: string;
} {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return { fileName: path, dirPath: "" };
  }
  return { fileName: path.slice(index + 1), dirPath: path.slice(0, index) };
}

export type CommitBlocker =
  | "offline"
  | "committing"
  | "nothing-staged"
  | "empty-message"
  | null;

/**
 * Why Commit is refusing, or null when it is not.
 *
 * A disabled button that does not say why is indistinguishable from a broken
 * one, so this returns a reason and the panel prints it under the button. The
 * server refuses both of the last two cases as well, with its own copy — this
 * exists so the refusal arrives before the click rather than after it.
 *
 * Checked in the order a person meets them: an offline workspace makes every
 * other question moot, and a commit already in flight outranks the contents of
 * the box.
 */
export function commitBlocker(input: {
  canMutate: boolean;
  committing: boolean;
  stagedCount: number;
  message: string;
}): CommitBlocker {
  if (!input.canMutate) {
    return "offline";
  }
  if (input.committing) {
    return "committing";
  }
  if (input.stagedCount === 0) {
    return "nothing-staged";
  }
  if (input.message.trim().length === 0) {
    return "empty-message";
  }
  return null;
}

export function commitBlockerMessage(blocker: CommitBlocker): string | null {
  switch (blocker) {
    case "offline":
      return "The workspace is offline, so nothing can be committed right now.";
    case "committing":
      return "Committing…";
    case "nothing-staged":
      return "Stage a file first — a commit only includes what is staged.";
    case "empty-message":
      return "Write a commit message to describe what changed.";
    default:
      return null;
  }
}

/**
 * What one Discard takes away.
 *
 * Discard restores from the *index*, not from the last commit — the same
 * meaning VS Code gives the word. That distinction is the whole reason this
 * copy is written per file rather than as one sentence: on a file you have
 * already staged, Discard throws away only the edits made since you staged,
 * and the staged version survives. Telling someone their work is about to be
 * destroyed when it is not is as bad as the reverse.
 */
function describeOne(file: ChangeRow): string {
  if (file.untracked) {
    return `${file.path} is not tracked by git, so discarding it deletes the file from the workspace.`;
  }
  if (file.status === "U") {
    return `The conflict markers and edits in ${file.path} are thrown away, and the file goes back to the version git has recorded for it.`;
  }
  if (file.status === "D") {
    return `${file.path} is put back as git has it recorded.`;
  }
  if (file.status === "R" && file.oldPath) {
    return `The rename of ${file.oldPath} to ${file.path} is undone, along with any edits made since it was recorded.`;
  }
  return `Every edit to ${file.path} since it was last staged or committed is thrown away.`;
}

/**
 * The question to ask before a Discard, in words that name what disappears.
 *
 * Discard is the only button in this panel that destroys work, and it destroys
 * it in several different ways depending on the file: an edit reverts, an
 * untracked file is deleted outright, a deletion comes back. Saying "are you
 * sure?" over all of them tells the person nothing they did not already know.
 * Saying which one is about to happen is the point of asking.
 */
export function describeDiscard(files: ChangeRow[]): DestructiveConfirmRequest {
  const untrackedCount = files.filter((file) => file.untracked).length;
  const trackedCount = files.length - untrackedCount;
  const cancelLabel = "Keep the changes";
  /*
   * The reassurance is as load-bearing as the warning. Someone about to click
   * this has usually just staged something, and needs to know in the same
   * breath that they are not about to lose it.
   */
  const stagedNote =
    "Anything you have already staged is kept — to drop that too, unstage it first and discard again.";

  if (files.length === 1 && files[0]) {
    const file = files[0];
    const { fileName } = splitPath(file.path);
    return {
      title: file.untracked
        ? `Delete ${fileName}?`
        : `Discard changes in ${fileName}?`,
      description: `${describeOne(file)} This cannot be undone, and Paco keeps no copy.${file.untracked ? "" : ` ${stagedNote}`}`,
      confirmLabel: file.untracked ? "Delete file" : "Discard changes",
      cancelLabel,
    };
  }

  const parts: string[] = [];
  if (trackedCount > 0) {
    parts.push(
      `${trackedCount} tracked ${trackedCount === 1 ? "file goes" : "files go"} back to the version git has recorded`,
    );
  }
  if (untrackedCount > 0) {
    parts.push(
      `${untrackedCount} untracked ${untrackedCount === 1 ? "file is" : "files are"} deleted from the workspace`,
    );
  }

  return {
    title: `Discard changes in ${files.length} files?`,
    description: `${parts.join(", and ")}. This cannot be undone, and Paco keeps no copy.${trackedCount > 0 ? ` ${stagedNote}` : ""}`,
    confirmLabel:
      untrackedCount > 0 ? "Discard and delete" : "Discard all changes",
    cancelLabel,
  };
}

/** How many rows the two lists hold between them. */
export function totalChangeCount(status: WorkingTreeStatus | null): number {
  if (!status) {
    return 0;
  }
  return (
    status.staged.length + status.unstaged.length + status.untracked.length
  );
}

/**
 * The `CHANGES` list: tracked edits, conflicts and untracked files, flat.
 *
 * Sorted by path rather than kept in two runs, because the operator asked for
 * a flat list of files, and "tracked ones first, then new ones" is a folder
 * tree by another name — it groups by something other than where the file is.
 */
export function workingTreeRows(status: WorkingTreeStatus): ChangeRow[] {
  const rows: ChangeRow[] = [
    ...status.unstaged.map((file) => ({ ...file, untracked: false })),
    ...status.untracked.map((file) => ({ ...file, untracked: true })),
  ];
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Whether a patch has an older side worth putting in a second column.
 *
 * The split renderer falls back to one column for a file that is purely added
 * or purely deleted — there is nothing to put on the left — so on a new file
 * the Split button flipped its own highlight and changed nothing on screen,
 * which reads as a broken button. Disabling it, and saying why, is the honest
 * version of the same fact. This is that check, done on the patch text: a
 * removed line and an added line that are not the two file headers.
 */
export function patchHasBothSides(patch: string): boolean {
  let removed = false;
  let added = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("-")) {
      removed = true;
    } else if (line.startsWith("+")) {
      added = true;
    }
    if (removed && added) {
      return true;
    }
  }
  return false;
}

/** The `STAGED CHANGES` list. Nothing in the index is ever untracked. */
export function stagedRows(status: WorkingTreeStatus): ChangeRow[] {
  return status.staged.map((file) => ({ ...file, untracked: false }));
}
