"use client";

import { Play, Square } from "lucide-react";

/**
 * Start / Stop for the app shown in the Preview tab.
 *
 * These used to live in the session header, in a corner that gave no clue
 * which pane would react: you pressed a play icon in the top right and the
 * result appeared somewhere else entirely. They sit in the Preview toolbar
 * now, beside Reload and "open in a new tab", so every control for the running
 * app is in one row.
 *
 * Busy is a state of its own rather than a disabled Start. Starting an app can
 * take a minute — it installs and builds — and a button that only greys out
 * reads as broken.
 */
export function PreviewRunControls({
  running,
  starting,
  stopping,
  onStart,
  onStop,
}: {
  running: boolean;
  starting: boolean;
  stopping: boolean;
  onStart?: () => void;
  onStop?: () => void;
}) {
  if (starting || stopping) {
    return (
      <button className="btn btn-ghost btn-xs" disabled type="button">
        <span
          aria-hidden="true"
          className="loading loading-spinner loading-xs"
        />
        {starting ? "Starting…" : "Stopping…"}
      </button>
    );
  }

  if (running) {
    return onStop ? (
      <button className="btn btn-ghost btn-xs" onClick={onStop} type="button">
        <Square aria-hidden="true" className="size-3 fill-current" />
        Stop preview
      </button>
    ) : null;
  }

  return onStart ? (
    <button className="btn btn-primary btn-xs" onClick={onStart} type="button">
      <Play aria-hidden="true" className="size-3 fill-current" />
      Start preview
    </button>
  ) : null;
}
