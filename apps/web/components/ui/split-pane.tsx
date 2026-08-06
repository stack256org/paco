"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A two-pane horizontal split with a draggable divider.
 *
 * Written rather than pulled in because the only thing this app needs is one
 * horizontal splitter, and `react-resizable-panels` would be a dependency and a
 * second layout system for it.
 *
 * The width is the *left* pane's percentage of the container, persisted per
 * `storageKey` so a chosen split survives navigation and reload — an expert
 * tool should not re-litigate its layout every time you open it.
 *
 * Below `sm` the panes stack and the divider is not rendered: 25/75 side by
 * side is unusable on a phone, and a drag handle for a split that does not
 * exist is worse than none.
 */

const MIN_PERCENT = 15;
const MAX_PERCENT = 75;
/** Nudge per arrow-key press, so the divider is operable without a mouse. */
const KEYBOARD_STEP_PERCENT = 2;

function clamp(percent: number): number {
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
}

function readStoredPercent(storageKey: string, fallback: number): number {
  if (typeof window === "undefined") {
    return fallback;
  }

  const stored = Number.parseFloat(
    window.localStorage.getItem(storageKey) ?? "",
  );
  return Number.isFinite(stored) ? clamp(stored) : fallback;
}

export function SplitPane({
  left,
  right,
  storageKey,
  defaultLeftPercent = 25,
  leftLabel,
  rightLabel,
  className,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  /** localStorage key for the remembered split. */
  storageKey: string;
  defaultLeftPercent?: number;
  /** Names the panes for the divider's accessible label. */
  leftLabel: string;
  rightLabel: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent);
  const [dragging, setDragging] = useState(false);

  // Read after mount: localStorage is not available while rendering on the
  // server, and a mismatched first paint would be a visible jump.
  useEffect(() => {
    setLeftPercent(readStoredPercent(storageKey, defaultLeftPercent));
  }, [storageKey, defaultLeftPercent]);

  const commit = useCallback(
    (percent: number) => {
      const next = clamp(percent);
      setLeftPercent(next);
      window.localStorage.setItem(storageKey, String(next));
    },
    [storageKey],
  );

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const bounds = container.getBoundingClientRect();
      if (bounds.width === 0) {
        return;
      }

      commit(((event.clientX - bounds.left) / bounds.width) * 100);
    };

    const stop = () => setDragging(false);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, commit]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col overflow-hidden sm:flex-row",
        className,
      )}
      ref={containerRef}
    >
      {/*
        One element carries the width, not a wrapper around another: a
        percentage width on a child of an auto-sized parent resolves against a
        box that is itself sized by its content, so the pane collapsed to the
        width of its text and left a gap where the other 25% should have been.

        `flex-1` on mobile splits the height; `sm:flex-none` hands sizing over
        to the percentage once the panes sit side by side.
      */}
      <div
        className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden sm:w-(--split-left) sm:flex-none"
        style={{ ["--split-left" as string]: `${leftPercent}%` }}
      >
        {left}
      </div>

      {/*
        A real slider rather than a bare div: dragging is the fast path, but the
        divider still has to be reachable and movable from the keyboard.

        `touch-none` because a pointer drag on a touch screen would otherwise
        scroll the page instead of moving the divider.
      */}
      <button
        aria-label={`Resize ${leftLabel} and ${rightLabel} panes`}
        aria-orientation="vertical"
        aria-valuemax={MAX_PERCENT}
        aria-valuemin={MIN_PERCENT}
        aria-valuenow={Math.round(leftPercent)}
        className={cn(
          "hidden w-1 shrink-0 cursor-col-resize touch-none border-none bg-base-300 p-0 transition-colors sm:block",
          "hover:bg-primary focus-visible:bg-primary focus-visible:outline-none",
          dragging && "bg-primary",
        )}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            commit(leftPercent - KEYBOARD_STEP_PERCENT);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            commit(leftPercent + KEYBOARD_STEP_PERCENT);
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        role="slider"
        tabIndex={0}
        type="button"
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-base-300 border-t sm:border-t-0">
        {right}
      </div>
    </div>
  );
}
