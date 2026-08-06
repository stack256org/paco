/**
 * The words Paco uses about archiving and restoring a workspace.
 *
 * Kept in one place because the same promise is made in three: the dialog that
 * archives, the switcher section that lists what was archived, and the notice
 * shown when you open an archived workspace. They disagreed before — the dialog
 * said "you can reopen it from the Archive list" and no such list existed —
 * which is how archiving became a one-way door that looked reversible.
 *
 * What is actually true, and what this copy is careful to say:
 *
 * - Archiving runs `docker stop`. The container is stopped, never removed, and
 *   the workspace itself is a plain directory on the host, so every file, every
 *   branch and every chat survives untouched.
 * - Restoring only flips the session back to running. It deliberately does not
 *   start a container — the next thing that needs one wakes it.
 * - The one thing that does not come back by itself is the app the user had
 *   running: stopping the container killed that process. They press
 *   "Start preview" again, which is the same button they used the first time.
 */

/** Whether an archived workspace can be restored right now. */
export type ArchivedWorkspacePhase = "settling" | "restorable";

/** The label on the button that runs the app, quoted by the copy below. */
const START_PREVIEW_LABEL = "Start preview";

export const ARCHIVE_COPY = {
  /** Heading of the archived list inside the workspace switcher. */
  sectionTitle: "Archived",
  sectionHint: "Chats and files are kept exactly as they were.",
  sectionEmpty: "Nothing archived yet.",
  sectionLoadFailed: "We couldn't load your archived workspaces.",
  restoreAction: "Restore",
  restoringAction: "Restoring…",
  restoreFailedFallback: "We couldn't restore that workspace. Try again.",
} as const;

/**
 * What the archive confirmation says will happen.
 *
 * Named after the workspace so the sentence reads as being about a specific
 * thing the user recognises rather than about a feature.
 */
export function archiveConfirmBody(title: string): string {
  return `"${title}" closes and its workspace stops running. Nothing is deleted — your chats, files and branches stay exactly as they are, and you can bring it back from "${ARCHIVE_COPY.sectionTitle}" in this menu. The one thing that does not come back on its own is your running app: press "${START_PREVIEW_LABEL}" again after restoring.`;
}

export interface ArchivedWorkspaceNotice {
  headline: string;
  detail: string;
  actionLabel: string;
  actionDisabled: boolean;
}

/**
 * Which phase an archived workspace is in.
 *
 * Archiving stops the container in the background, after the response has been
 * sent. Restoring during that window is refused by the API, so the UI has to be
 * able to say "not yet" instead of offering a button that fails.
 */
export function archivedWorkspacePhase(input: {
  hasRuntimeSandboxState: boolean;
}): ArchivedWorkspacePhase {
  return input.hasRuntimeSandboxState ? "settling" : "restorable";
}

/** The notice shown over the message box of an archived workspace. */
export function archivedWorkspaceNotice(
  phase: ArchivedWorkspacePhase,
): ArchivedWorkspaceNotice {
  if (phase === "settling") {
    return {
      headline: "This workspace is still closing down",
      detail: "Give it a few seconds, then restore it.",
      actionLabel: ARCHIVE_COPY.restoreAction,
      actionDisabled: true,
    };
  }

  return {
    headline: "This workspace is archived",
    detail: `Your chats and files are all still here. Restoring brings them back — your app is not running, so press "${START_PREVIEW_LABEL}" when you want to see it again.`,
    actionLabel: ARCHIVE_COPY.restoreAction,
    actionDisabled: false,
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
 * What to tell the user when restoring failed.
 *
 * The API's own wording wins — it is the only party that knows *why*, and its
 * 409 ("still going to sleep") is the one failure a user can act on. The
 * fallback exists for network errors, which arrive with a message written for
 * developers or with no message at all.
 */
export function restoreFailureMessage(error: unknown): string {
  return readErrorMessage(error) ?? ARCHIVE_COPY.restoreFailedFallback;
}
