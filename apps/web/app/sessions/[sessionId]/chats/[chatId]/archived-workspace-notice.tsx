"use client";

import { Archive } from "lucide-react";
import { useState } from "react";
import {
  archivedWorkspaceNotice,
  archivedWorkspacePhase,
  restoreFailureMessage,
} from "@/lib/sessions/archive-copy";
import { toast } from "@/lib/toast";

/**
 * What the chat shows when the workspace you are looking at is archived.
 *
 * It used to say "Unarchive it to resume" and offer nothing to click. The
 * unarchive call existed in the chat context the whole time and was destructured
 * as `_unarchiveSession` — wired up to nothing — so the sentence described an
 * action the user had no way to take.
 *
 * It sits *above* the composer rather than floating over it. As an overlay it
 * was absolutely positioned inside the composer's `overflow-hidden` box, which
 * measures about 90px: a notice with a sentence and a button measured 140px,
 * and the browser quietly cut 25px off each end — including part of the button
 * this whole change exists to add. The composer beneath is already disabled, so
 * covering it bought nothing anyway.
 *
 * The button does not start a container. Restoring flips the session back to
 * running, the page's reconnect probe then runs as it does on any other
 * workspace, and "Start preview" wakes the sandbox when the user asks for it.
 * That is why the copy says the app is not running rather than pretending
 * everything is exactly as it was left.
 */
export function ArchivedWorkspaceNotice({
  hasRuntimeSandboxState,
  onRestore,
}: {
  /**
   * True while the archive is still stopping the container in the background.
   * The API refuses to restore during that window, so the button waits.
   */
  hasRuntimeSandboxState: boolean;
  onRestore: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);
  const notice = archivedWorkspaceNotice(
    archivedWorkspacePhase({ hasRuntimeSandboxState }),
  );

  const handleRestore = async () => {
    setRestoring(true);
    try {
      await onRestore();
    } catch (error) {
      toast.error(restoreFailureMessage(error));
    } finally {
      setRestoring(false);
    }
  };

  return (
    /*
     * Always stacked. The conversation pane is resizable and is often narrower
     * than any viewport breakpoint, so `sm:alert-horizontal` would go
     * horizontal inside a 400px column and squeeze the sentence into a ribbon.
     */
    <div
      className="alert alert-vertical items-start gap-1.5 px-3 py-2"
      role="alert"
    >
      <p className="flex items-center gap-2 font-medium text-base-content text-sm">
        <Archive aria-hidden="true" className="size-4 shrink-0" />
        {notice.headline}
      </p>
      <p className="text-base-content/70 text-xs">{notice.detail}</p>
      <button
        className="btn btn-primary btn-sm"
        disabled={notice.actionDisabled || restoring}
        onClick={handleRestore}
        type="button"
      >
        {restoring ? (
          <span
            aria-hidden="true"
            className="loading loading-spinner loading-xs"
          />
        ) : null}
        {notice.actionLabel}
      </button>
    </div>
  );
}
