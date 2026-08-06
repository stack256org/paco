import { formatBytes, pluralize } from "@/lib/reaping/format-bytes";
import type { UnsavedWork } from "@/lib/reaping/types";

/**
 * The words Paco uses when a workspace is about to be deleted for good.
 *
 * Kept apart from the component, and unit tested, because these are the
 * sentences somebody reads in order to decide. Each one has to say three
 * things: what goes, what stays, and what it would cost to be wrong.
 *
 * What is actually true, and what this copy is careful not to overstate:
 *
 * - `DELETE /api/sessions/[sessionId]` removes the sandbox container, then the
 *   workspace directory — the repository *and* every chat worktree under it —
 *   and only then the database row. The chats go with the row, so "every chat"
 *   is literal rather than a figure of speech.
 * - Nothing about this is reversible. Archiving is, and the two live next to
 *   each other, so the difference is said out loud rather than implied by a red
 *   button.
 * - Anything pushed to GitHub survives, because it was never only here. That is
 *   the one reassurance worth giving, and it is only worth giving where it is
 *   true — which is why the refusal below is a separate question rather than a
 *   footnote on this one.
 */

export interface DeleteWorkspaceConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  /** Named only where "Cancel" understates what the safe answer is. */
  cancelLabel?: string;
}

export const DELETE_WORKSPACE_COPY = {
  /** The control on an archived row. */
  rowAction: "Delete",
  deletingAction: "Deleting…",
  deleteFailedFallback: "We couldn't delete that workspace. Try again.",
  /**
   * A forced delete that is *still* refused. The route only refuses on unsaved
   * work, and `?force=1` skips that check, so this means something else went
   * wrong on the way — worth a sentence rather than a silent close.
   */
  stillRefused:
    "Paco still won't delete that workspace. Reload the page and try again.",
} as const;

/** The first question: the ordinary delete, with nothing unsaved at stake. */
export function deleteWorkspaceConfirm(
  workspaceTitle: string,
): DeleteWorkspaceConfirmCopy {
  return {
    title: "Delete this workspace?",
    description: [
      `"${workspaceTitle}" is deleted permanently — its files on this machine, every chat in it, and the sandbox it ran in.`,
      "Archiving can be undone. This cannot: it does not go back to Archived, and nothing in Paco can bring it back.",
      "Anything you already pushed to GitHub is safe. That lives on GitHub, not here, and is untouched.",
    ].join(" "),
    confirmLabel: "Delete it",
    busyLabel: DELETE_WORKSPACE_COPY.deletingAction,
  };
}

/**
 * What is in the workspace that is nowhere else.
 *
 * The route refuses the delete when the probe found uncommitted files, unpushed
 * commits, *or* could not read the repository at all — and the last case
 * arrives as zeros rather than as an error. Zeros therefore mean "we could not
 * tell", never "there is nothing here", and saying so is the honest answer.
 */
export function unsavedWorkSentence(
  workspaceTitle: string,
  work: UnsavedWork,
): string {
  const parts: string[] = [];

  if (work.uncommittedFiles > 0) {
    parts.push(
      pluralize(work.uncommittedFiles, "uncommitted file", "uncommitted files"),
    );
  }

  if (work.unpushedCommits > 0) {
    const one = work.unpushedCommits === 1;
    parts.push(
      `${pluralize(work.unpushedCommits, "commit", "commits")} that ${
        work.hasRemote
          ? `${one ? "was" : "were"} never pushed`
          : `${one ? "exists" : "exist"} on no remote, because none is configured`
      }`,
    );
  }

  if (parts.length === 0) {
    return `Paco could not read the git history in "${workspaceTitle}", so treat everything in it as unsaved.`;
  }

  return `"${workspaceTitle}" holds ${parts.join(" and ")} — that work exists nowhere else.`;
}

/**
 * The second question, asked only after the first delete was refused.
 *
 * A separate decision with its own button, not the first one relabelled: the
 * person agreed to delete a workspace they believed was safe to lose, and this
 * is new information about that workspace. Agreeing to the first is not
 * agreement to this.
 */
export function deleteWorkspaceAnywayConfirm(
  workspaceTitle: string,
  work: UnsavedWork,
): DeleteWorkspaceConfirmCopy {
  return {
    title: "This work exists nowhere else",
    description: [
      unsavedWorkSentence(workspaceTitle, work),
      "Cancel, restore the workspace and push it to GitHub — then deleting costs you nothing.",
      "Delete anyway and that work goes with it. GitHub cannot give back what was never pushed to it.",
    ].join(" "),
    confirmLabel: "Delete anyway",
    /*
     * Not "Cancel". Here the safe answer is a real choice — go back and push
     * the work — not the absence of one, and the two buttons should read as a
     * pair of decisions rather than an action and an escape hatch.
     */
    cancelLabel: "Keep it",
    busyLabel: DELETE_WORKSPACE_COPY.deletingAction,
  };
}

export interface DeletedNotice {
  title: string;
  /** Only present when there was something worth reporting. */
  description?: string;
}

/**
 * What is said once the workspace is gone.
 *
 * The reclaimed space is the one number that makes the delete feel like it did
 * something; the warnings are the route admitting a container or a directory
 * survived it, which an operator would rather hear than not.
 */
export function deletedNotice(
  workspaceTitle: string,
  freedBytes: number,
  warnings: string[] = [],
): DeletedNotice {
  const details: string[] = [];

  if (freedBytes > 0) {
    details.push(`Freed ${formatBytes(freedBytes)}.`);
  }
  details.push(...warnings);

  return {
    title: `Deleted "${workspaceTitle}".`,
    ...(details.length > 0 ? { description: details.join(" ") } : {}),
  };
}

function readErrorMessage(error: unknown): string | null {
  if (typeof error === "string") {
    return error.trim() || null;
  }

  if (error instanceof Error) {
    return error.message.trim() || null;
  }

  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message: unknown };
    return typeof message === "string" ? message.trim() || null : null;
  }

  return null;
}

/**
 * What to tell the user when deleting failed.
 *
 * The API's own wording wins where there is one — it is the only party that
 * knows why. The fallback covers network errors, which arrive written for
 * developers or with no message at all.
 */
export function deleteFailureMessage(error: unknown): string {
  return readErrorMessage(error) ?? DELETE_WORKSPACE_COPY.deleteFailedFallback;
}
