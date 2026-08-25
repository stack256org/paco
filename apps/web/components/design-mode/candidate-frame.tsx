"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { WebAgentDesignProgressData } from "@/app/types";
import { cn } from "@/lib/utils";
import { AnnotationChip } from "./annotation-chip";
import { annotationsForCandidate, type DesignAnnotation } from "./annotations";
import type { DesignCandidateView } from "./candidate-progress";
import {
  DESIGN_INSPECT_ARM_MESSAGE,
  parseInspectClickMessage,
} from "./inspector-message";

/** What each streamed status reads as under a candidate's label. */
const STATUS_LABEL: Record<WebAgentDesignProgressData["status"], string> = {
  running: "Designing…",
  committing: "Committing…",
  completed: "Ready",
  failed: "Failed",
};

const STATUS_BADGE: Record<WebAgentDesignProgressData["status"], string> = {
  running: "badge-info",
  committing: "badge-info",
  completed: "badge-success",
  failed: "badge-error",
};

export interface CandidateFrameProps {
  candidate: DesignCandidateView;
  annotations: DesignAnnotation[];
  /** Whether this is the candidate Iterate and Accept act on. */
  selected: boolean;
  editingAnnotationId: string | null;
  onSelect: (index: number) => void;
  onInspectClick: (candidate: number, selector: string, text: string) => void;
  onAnnotationEditStart: (id: string) => void;
  onAnnotationEditCancel: () => void;
  onAnnotationNoteCommit: (id: string, note: string) => void;
  onAnnotationRemove: (id: string) => void;
}

/**
 * One design candidate: its label, its live status, its preview, and the
 * notes taken on it.
 *
 * The preview is armed for click-to-inspect over `postMessage`, both
 * directions pinned to an exact origin as `public/design-inspector.js`
 * requires — arming is sent to the candidate's own origin, and an incoming
 * click is accepted only from that origin *and* from this frame's own
 * window. Without the second check every frame on the page would record a
 * click made in any one of them, since they all share the one `message`
 * listener target.
 *
 * Arming happens on every `load`, not once on mount: the inspector script is
 * part of the candidate's page, so a navigation inside the preview replaces
 * it with a fresh, unarmed copy.
 */
export function CandidateFrame({
  candidate,
  annotations,
  selected,
  editingAnnotationId,
  onSelect,
  onInspectClick,
  onAnnotationEditStart,
  onAnnotationEditCancel,
  onAnnotationNoteCommit,
  onAnnotationRemove,
}: CandidateFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const previewOrigin = useMemo(() => {
    if (!candidate.previewUrl) {
      return null;
    }
    try {
      return new URL(candidate.previewUrl).origin;
    } catch {
      return null;
    }
  }, [candidate.previewUrl]);

  const arm = useCallback(() => {
    if (!previewOrigin) {
      return;
    }
    frameRef.current?.contentWindow?.postMessage(
      DESIGN_INSPECT_ARM_MESSAGE,
      previewOrigin,
    );
  }, [previewOrigin]);

  useEffect(() => {
    if (!previewOrigin) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== previewOrigin) {
        return;
      }
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const click = parseInspectClickMessage(event.data);
      if (!click) {
        return;
      }
      onInspectClick(candidate.index, click.selector, click.text);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [previewOrigin, candidate.index, onInspectClick]);

  const ownAnnotations = annotationsForCandidate(annotations, candidate.index);

  return (
    <div
      className={cn(
        "card card-border card-xs bg-base-100",
        selected && "border-primary",
      )}
    >
      <div className="card-body gap-2">
        <div className="flex items-center justify-between gap-2">
          <label className="flex min-w-0 cursor-pointer items-center gap-2">
            <input
              aria-label={`Work on candidate ${candidate.index}`}
              checked={selected}
              className="radio radio-xs"
              name="design-candidate"
              onChange={() => onSelect(candidate.index)}
              type="radio"
            />
            <span className="truncate font-medium text-sm">
              Candidate {candidate.index}
            </span>
          </label>
          <span
            className={cn("badge badge-sm", STATUS_BADGE[candidate.status])}
          >
            {STATUS_LABEL[candidate.status]}
          </span>
        </div>

        {candidate.error ? (
          <p className="text-error text-xs">{candidate.error}</p>
        ) : null}

        {candidate.previewUrl ? (
          /*
           * Deliberately unsandboxed, for the same reasons `EmbeddedFrame`
           * (`app/sessions/[sessionId]/chats/[chatId]/workspace-panel.tsx`)
           * gives for the chat's own preview: a dev server needs scripts,
           * storage and its own origin to run at all, and `allow-scripts`
           * with `allow-same-origin` lets a frame drop the sandbox anyway.
           *
           * A candidate preview needs one thing more — the injected
           * inspector has to `postMessage` in both directions, and an opaque
           * (sandboxed) origin can neither be armed at an exact
           * `targetOrigin` nor be recognised by `event.origin` on the way
           * back.
           *
           * What bounds it is upstream: the frame is the user's own dev
           * server for their own candidate worktree, published from their
           * own sandbox container and gated by the same forward auth as the
           * chat's preview.
           */
          // oxlint-disable-next-line react/iframe-missing-sandbox -- see above
          <iframe
            className="aspect-3/4 w-full rounded-box border border-base-300 bg-base-200"
            onLoad={arm}
            ref={frameRef}
            src={candidate.previewUrl}
            title={`Design candidate ${candidate.index} preview`}
          />
        ) : (
          <p className="rounded-box bg-base-200 p-3 text-base-content/60 text-xs">
            No preview base domain is configured, so this candidate cannot be
            shown. Its work is still on its own branch.
          </p>
        )}

        <p className="text-base-content/60 text-xs">
          Click anything in the preview to note a change.
        </p>

        {ownAnnotations.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {ownAnnotations.map((annotation) => (
              <AnnotationChip
                annotation={annotation}
                editing={editingAnnotationId === annotation.id}
                key={annotation.id}
                onEditCancel={onAnnotationEditCancel}
                onEditStart={onAnnotationEditStart}
                onNoteCommit={onAnnotationNoteCommit}
                onRemove={onAnnotationRemove}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
