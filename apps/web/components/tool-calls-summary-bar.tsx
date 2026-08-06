"use client";

import { ChevronRight, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type StatusWordPair = {
  present: string;
  past: string;
};

const STATUS_WORD_PAIRS: StatusWordPair[] = [
  { present: "Pondering", past: "Pondered" },
  { present: "Crafting", past: "Crafted" },
  { present: "Vibing", past: "Vibed" },
  { present: "Simmering", past: "Simmered" },
  { present: "Marinating", past: "Marinated" },
  { present: "Philosophising", past: "Philosophised" },
  { present: "Ruminating", past: "Ruminated" },
];

function hashString(value: string): number {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }

  return hash;
}

function getStatusWordPair(seed: string | null): StatusWordPair {
  if (!seed) {
    return STATUS_WORD_PAIRS[0];
  }

  return STATUS_WORD_PAIRS[hashString(seed) % STATUS_WORD_PAIRS.length];
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

function renderSegments(segments: string[]) {
  return segments.map((segment, i) => (
    <span key={i}>
      <span className="text-base-content/40"> · </span>
      {segment}
    </span>
  ));
}

export function ToolCallsSummaryBar({
  isExpanded,
  onToggle,
  isStreaming,
  toolCallCount,
  changedFiles,
  durationMs,
  startedAt,
  statusWordSeed,
  onRevert,
  isReverting = false,
}: {
  isExpanded: boolean;
  onToggle: () => void;
  isStreaming: boolean;
  toolCallCount: number;
  /** Unique file paths modified by write/edit tool calls in this turn. */
  changedFiles: string[];
  /** Final generation duration in ms (for completed messages). */
  durationMs: number | null;
  /** ISO timestamp of when generation started — i.e. the preceding user
   *  message's createdAt — used for a live counter while streaming. */
  startedAt: string | null;
  /** Stable per-message seed used to choose a status word pair. */
  statusWordSeed: string | null;
  /**
   * Undo this turn's file changes.
   *
   * Omitted when there is nothing to undo — a turn that only read, or one that
   * ran before checkpoints existed and so has no restore point recorded.
   */
  onRevert?: () => void;
  isReverting?: boolean;
}) {
  // ---------------------------------------------------------------------------
  // Elapsed time logic
  //
  // Completed messages  → use the pre-computed durationMs (accurate, static).
  // Streaming messages  → tick a live counter from startedAt (the moment the
  //                        user sent their message).
  // ---------------------------------------------------------------------------
  const startMs = startedAt ? new Date(startedAt).getTime() : null;

  const computeLiveElapsed = () =>
    startMs != null
      ? Math.max(0, Math.floor((Date.now() - startMs) / 1000))
      : 0;

  const [liveElapsed, setLiveElapsed] = useState(computeLiveElapsed);

  useEffect(() => {
    if (!isStreaming) return;

    setLiveElapsed(computeLiveElapsed());
    const interval = setInterval(() => {
      setLiveElapsed(computeLiveElapsed());
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable per startMs
  }, [isStreaming, startMs]);

  // Pick the right elapsed value.
  // When streaming ends for messages created during this session, durationMs
  // will be null (it's only computed server-side for initial DB messages).
  // Fall back to liveElapsed so the timer freezes at the last ticked value
  // instead of dropping to 0.
  const elapsedSeconds = isStreaming
    ? liveElapsed
    : durationMs != null
      ? Math.max(0, Math.round(durationMs / 1000))
      : liveElapsed;

  const statusWordPair = getStatusWordPair(statusWordSeed);

  /*
   * A live turn and a finished turn want different sentences.
   *
   * While the agent is working, the whimsical present tense is the point: it
   * is the one signal that something is still happening, and a changing word
   * reads as alive in a way that a spinner does not.
   *
   * Once it has finished, that word has no job left. "Marinated · 3m 43s · 31
   * tool calls · 10 files changed" led with the least informative token on the
   * row, and "tool calls" is a phrase from the implementation — someone who
   * has never used a terminal has no idea whether 31 of them is a lot. So a
   * finished turn leads with what it did to their project, and counts steps.
   */
  const stepLabel =
    toolCallCount > 0
      ? `${toolCallCount} step${toolCallCount === 1 ? "" : "s"}`
      : null;
  const filesLabel =
    changedFiles.length > 0
      ? `${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} changed`
      : null;

  const statusLabel = isStreaming
    ? `${statusWordPair.present}…`
    : (filesLabel ?? "No files changed");

  const desktopSegments: string[] = [];
  const mobileSegments: string[] = [];

  if (elapsedSeconds > 0) {
    const elapsedLabel = formatElapsedTime(elapsedSeconds);
    desktopSegments.push(elapsedLabel);
    mobileSegments.push(elapsedLabel);
  }

  if (stepLabel) {
    desktopSegments.push(stepLabel);
    mobileSegments.push(stepLabel);
  }

  const fullSummary = [statusLabel, ...desktopSegments].join(" · ");

  return (
    <div className="my-1.5 border border-transparent py-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-label={`${fullSummary}. ${isExpanded ? "Hide" : "Show"} what the assistant did.`}
        title={fullSummary}
        className={cn(
          "group flex w-full max-w-full items-center gap-2 rounded-md py-px text-left text-sm text-base-content/60 tabular-nums transition-colors hover:text-base-content sm:inline-flex sm:w-auto",
          isStreaming && "text-base-content/90",
        )}
      >
        {/*
          daisyUI's `status`, not a hand-rolled `rounded-full` div. It is the
          component for exactly this — a small dot standing for the state of
          something — so it follows the theme's sizing tokens instead of a
          fixed `size-2` that ignores them.
        */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span
            className={cn(
              "status status-md",
              isStreaming && "animate-pulse motion-reduce:animate-none",
            )}
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 overflow-hidden whitespace-nowrap leading-none sm:flex-none sm:overflow-visible sm:whitespace-normal",
            isStreaming && "animate-pulse motion-reduce:animate-none",
          )}
        >
          {statusLabel}
          {mobileSegments.length > 0 && (
            <span className="inline-block max-w-full truncate align-bottom sm:hidden">
              {renderSegments(mobileSegments)}
            </span>
          )}
          {desktopSegments.length > 0 && (
            <span className="hidden sm:inline">
              {renderSegments(desktopSegments)}
            </span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-base-content/50 transition-transform duration-200 ease-out motion-reduce:transition-none",
            isExpanded && "rotate-90",
          )}
        />
      </button>
      {/*
        Outside the toggle button, not inside it: nesting a button inside a
        button is invalid, and clicking revert would also expand the turn.

        Only shown once the turn has finished. Reverting mid-turn would race
        the agent that is still writing.
      */}
      {onRevert && !isStreaming && (
        <button
          type="button"
          onClick={onRevert}
          disabled={isReverting}
          title="Put the files back the way they were before this turn"
          className="ml-2 inline-flex items-center gap-1 rounded-md px-1.5 py-px align-middle text-xs text-base-content/50 transition-colors hover:bg-base-200/60 hover:text-base-content disabled:pointer-events-none disabled:opacity-60"
        >
          <Undo2 className="size-3 shrink-0" />
          {isReverting ? "Undoing…" : "Undo these changes"}
        </button>
      )}
    </div>
  );
}
