"use client";

import {
  ArrowLeft,
  ArrowRight,
  FileDiff,
  FileLock2,
  Loader2,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  FileDiff as FileDiffResult,
  SelectedFile,
} from "./source-control-contract";
import { splitPath } from "./source-control-contract";

/**
 * The before/after view for one file.
 *
 * This is the half the operator said was missing: the old panel listed changed
 * files "as plain stuff" and never showed the comparison. It is deliberately
 * the larger half of the layout.
 *
 * The actual patch renderer arrives as `renderPatch` rather than being
 * imported here. `@pierre/diffs` paints into a shadow root from a web worker,
 * which no server renderer can produce — so keeping it behind a prop is what
 * lets every other state in this file (loading, binary, rename, failure,
 * nothing-selected) be rendered and asserted in a test.
 */

export type SourceControlDiffProps = {
  /** The row that is open, or null when nothing has been clicked yet. */
  file: SelectedFile | null;
  diff: FileDiffResult | null;
  loading: boolean;
  error: string | null;
  /** Returns to the list. Only reachable on a narrow layout. */
  onBack: () => void;
  renderPatch: (input: { patch: string; path: string }) => ReactNode;
  /** Controls that belong to the diff itself, such as one column vs two. */
  toolbar?: ReactNode;
};

function DiffHeader({
  file,
  oldPath,
  onBack,
  toolbar,
}: {
  file: SelectedFile;
  oldPath: string | undefined;
  onBack: () => void;
  toolbar: ReactNode;
}) {
  const { fileName } = splitPath(file.path);

  return (
    <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-base-300 px-3 py-2">
      <button
        aria-label="Back to the list of changes"
        className="btn btn-ghost btn-xs btn-square shrink-0 lg:hidden"
        onClick={onBack}
        type="button"
      >
        <ArrowLeft aria-hidden className="size-4" />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 truncate font-medium font-mono text-sm">
          {fileName}
        </span>
        {/*
          `wrap-anywhere` and `min-w-0`, not `truncate`.

          A path is the one string here with no spaces in it, so a flex child
          holding one refuses to shrink below its full width unless it is told
          it may break mid-word — and the panel then pushes the page sideways.
          The repo has just finished removing a batch of exactly this bug.
        */}
        <span className="min-w-0 wrap-anywhere text-[11px] text-base-content/60">
          {oldPath ? (
            <>
              <span className="text-base-content/45">{oldPath}</span>
              <ArrowRight
                aria-hidden
                className="mx-1 inline-block size-3 align-[-1px]"
              />
              <span>{file.path}</span>
            </>
          ) : (
            file.path
          )}
        </span>
      </div>
      <span
        className={cn(
          "badge badge-sm shrink-0",
          file.staged ? "badge-success badge-soft" : "badge-ghost",
        )}
      >
        {file.staged ? "Staged" : "Working tree"}
      </span>
      {toolbar}
    </header>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {children}
    </div>
  );
}

export function SourceControlDiff({
  file,
  diff,
  loading,
  error,
  onBack,
  renderPatch,
  toolbar,
}: SourceControlDiffProps) {
  if (!file) {
    return (
      <Centered>
        <FileDiff aria-hidden className="size-8 text-base-content/30" />
        <p className="max-w-xs text-balance text-base-content/60 text-sm">
          Pick a file to see what changed in it.
        </p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <DiffHeader
        file={file}
        oldPath={diff?.oldPath}
        onBack={onBack}
        toolbar={toolbar}
      />
      {/*
        The scroll container is here, and it scrolls in both directions. A diff
        is as wide as its longest line and nothing can shorten it, so the choice
        is between a scrollbar on this box and a scrollbar on the whole page.
      */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {loading && (
          <Centered>
            <Loader2
              aria-hidden
              className="size-5 animate-spin text-base-content/50"
            />
            <p className="text-base-content/60 text-sm">Loading the diff…</p>
          </Centered>
        )}

        {!loading && error && (
          <Centered>
            <p className="max-w-md text-balance text-error text-sm">{error}</p>
          </Centered>
        )}

        {!(loading || error) && diff?.binary && (
          <Centered>
            <FileLock2 aria-hidden className="size-8 text-base-content/30" />
            <p className="max-w-md text-balance text-base-content/70 text-sm">
              This is a binary file. There are no lines to compare, so Paco
              cannot show a before and after for it.
            </p>
          </Centered>
        )}

        {!(loading || error) && diff && !diff.binary && (
          <>
            {diff.patch.trim().length > 0 ? (
              <div className="min-w-0">
                {renderPatch({ patch: diff.patch, path: file.path })}
              </div>
            ) : (
              <Centered>
                <p className="max-w-md text-balance text-base-content/60 text-sm">
                  {file.staged
                    ? "Nothing is staged for this file any more."
                    : "This file has no changes left outside the staged ones."}
                </p>
              </Centered>
            )}
          </>
        )}
      </div>
    </div>
  );
}
