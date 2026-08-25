"use client";

import { cn } from "@/lib/utils";
import { type DesignAnnotation, hasIterableAnnotations } from "./annotations";
import { CandidateFrame } from "./candidate-frame";
import type { DesignCandidateView } from "./candidate-progress";

/** Which design action is waiting on the server, if any. */
export type DesignPanelBusy = "iterating" | "accepting" | "discarding" | null;

export interface DesignPanelProps {
  candidates: DesignCandidateView[];
  annotations: DesignAnnotation[];
  /** The candidate Iterate and Accept act on — chosen by the frames' radios. */
  selectedCandidate: number;
  editingAnnotationId: string | null;
  busy: DesignPanelBusy;
  error: string | null;
  onSelectCandidate: (index: number) => void;
  onInspectClick: (candidate: number, selector: string, text: string) => void;
  onAnnotationEditStart: (id: string) => void;
  onAnnotationEditCancel: () => void;
  onAnnotationNoteCommit: (id: string, note: string) => void;
  onAnnotationRemove: (id: string) => void;
  onIterate: () => void;
  onAccept: (index: number) => void;
  onDiscard: () => void;
}

/**
 * The design turn's own surface: every candidate side by side, the notes
 * taken on them, and the three ways out — refine one, adopt one, or throw
 * them all away.
 *
 * Deliberately free of state and of hooks. Everything it renders is a prop,
 * which keeps the whole panel decidable from a fixture in a repo whose test
 * setup has no DOM (`design-panel.test.tsx` calls it as a plain function to
 * reach its handlers). The state itself lives in `design-mode-context.tsx`.
 */
export function DesignPanel({
  candidates,
  annotations,
  selectedCandidate,
  editingAnnotationId,
  busy,
  error,
  onSelectCandidate,
  onInspectClick,
  onAnnotationEditStart,
  onAnnotationEditCancel,
  onAnnotationNoteCommit,
  onAnnotationRemove,
  onIterate,
  onAccept,
  onDiscard,
}: DesignPanelProps) {
  const selected = candidates.find(
    (candidate) => candidate.index === selectedCandidate,
  );
  const selectedIsReady = selected?.status === "completed";
  const canIterate =
    !busy &&
    selectedIsReady &&
    hasIterableAnnotations(selectedCandidate, annotations);
  const canAccept = !busy && selectedIsReady;

  return (
    <section
      aria-label="Design candidates"
      className="card card-border card-sm mx-auto mb-2 w-full max-w-6xl bg-base-100"
    >
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title text-sm">Design candidates</h2>
          <button
            className="btn btn-ghost btn-xs"
            disabled={busy !== null}
            onClick={onDiscard}
            type="button"
          >
            {busy === "discarding" ? (
              <span className="loading loading-spinner loading-xs" />
            ) : null}
            Discard candidates
          </button>
        </div>

        {error ? (
          <div className="alert alert-error alert-soft text-sm" role="alert">
            {error}
          </div>
        ) : null}

        <div
          className={cn(
            "grid max-h-[55vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2",
            candidates.length > 2 && "xl:grid-cols-3",
          )}
        >
          {candidates.map((candidate) => (
            <CandidateFrame
              annotations={annotations}
              candidate={candidate}
              editingAnnotationId={editingAnnotationId}
              key={candidate.index}
              onAnnotationEditCancel={onAnnotationEditCancel}
              onAnnotationEditStart={onAnnotationEditStart}
              onAnnotationNoteCommit={onAnnotationNoteCommit}
              onAnnotationRemove={onAnnotationRemove}
              onInspectClick={onInspectClick}
              onSelect={onSelectCandidate}
              selected={candidate.index === selectedCandidate}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            className="btn btn-sm"
            disabled={!canIterate}
            onClick={onIterate}
            type="button"
          >
            {busy === "iterating" ? (
              <span className="loading loading-spinner loading-xs" />
            ) : null}
            Iterate on candidate {selectedCandidate}
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={!canAccept}
            onClick={() => onAccept(selectedCandidate)}
            type="button"
          >
            {busy === "accepting" ? (
              <span className="loading loading-spinner loading-xs" />
            ) : null}
            Accept candidate {selectedCandidate}
          </button>
        </div>
      </div>
    </section>
  );
}
