"use client";

import { Play, TriangleAlert } from "lucide-react";

/**
 * What the Preview tab shows when there is no app to embed.
 *
 * Three situations share this space and used to share one paragraph: the app
 * has never been started, it is starting, and it was running and has now
 * stopped. The third is the one that was missing. Paco would keep the iframe
 * mounted over a dead port and say nothing, so a crash looked like a blank page
 * with a "Stop preview" button beside it — an app that had died, described by
 * the interface as fine.
 *
 * The crash case gets the explanation in an alert with its own Start button,
 * rather than a line of red text under a generic hint, because it is the only
 * one of the three where something went wrong and the user needs both the
 * reason and the way out in the same place.
 */
export function PreviewNotRunning({
  starting,
  canRun,
  error,
  output,
  onStart,
}: {
  starting: boolean;
  /** False while the workspace is archived, asleep or still being created. */
  canRun: boolean;
  /** Why it is not running, in the words the hook chose. May be several lines. */
  error: string | null;
  /**
   * The app's own last output, when there was any.
   *
   * Rendered as code rather than folded into `error`. A stack trace set as a
   * wrapped paragraph is close to unreadable, and it is the one part of this
   * panel a developer will want to copy verbatim.
   */
  output?: string | null;
  onStart?: () => void;
}) {
  const headline = starting ? "Starting your app…" : "Your app is not running";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
      <p className="font-medium text-sm">{headline}</p>

      {error ? (
        <div
          className="alert alert-error alert-soft alert-vertical max-w-sm text-left"
          role="alert"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            <p className="whitespace-pre-wrap wrap-break-word text-xs">
              {error}
            </p>
          </div>

          {output ? (
            <div className="w-full min-w-0">
              <p className="mb-1 text-xs opacity-70">
                The last thing the app printed:
              </p>
              {/*
                `overflow-x-auto` on the block itself, so a long line scrolls
                inside the alert instead of widening it. This panel lives in a
                pane the user can drag down to a quarter of the window.
              */}
              <pre className="mockup-code max-h-40 w-full overflow-auto text-xs">
                <code>{output}</code>
              </pre>
            </div>
          ) : null}
          {onStart ? (
            <button
              // Deliberately uncoloured. The emphasised Start lives in the
              // toolbar; this one repeats it beside the explanation so the fix
              // is where the problem is described, and a second primary button
              // two rows away would only compete with the first.
              className="btn btn-sm"
              onClick={onStart}
              type="button"
            >
              <Play aria-hidden="true" className="size-3 fill-current" />
              Start preview
            </button>
          ) : null}
        </div>
      ) : (
        <p className="max-w-xs text-base-content/60 text-xs">
          {startingOrIdleHint({ starting, canRun })}
        </p>
      )}
    </div>
  );
}

function startingOrIdleHint({
  starting,
  canRun,
}: {
  starting: boolean;
  canRun: boolean;
}): string {
  if (starting) {
    return "This takes a moment the first time — the app has to install and build.";
  }

  if (canRun) {
    return "Press Start preview above to run your app here and watch it change as the agent works. If the workspace is asleep, this wakes it first.";
  }

  return "This workspace is archived, so there is nothing left to run.";
}
