"use client";

import { Check, X } from "lucide-react";
import { useRef } from "react";
import {
  annotationLabel,
  type DesignAnnotation,
  shortSelector,
} from "./annotations";

export interface AnnotationChipProps {
  annotation: DesignAnnotation;
  /** Whether this chip is the one currently being typed into. */
  editing: boolean;
  onEditStart: (id: string) => void;
  onEditCancel: () => void;
  onNoteCommit: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}

/**
 * One clicked element on a candidate preview, shown under its frame.
 *
 * Clicking the chip opens an inline input for the note, the same shape the
 * composer's inline question uses (`components/inline-question-input.tsx`):
 * the control the user is answering appears in place, Enter commits, Escape
 * cancels, and a Check/X pair does the same by pointer.
 *
 * The input is uncontrolled — its draft lives in the DOM, not in React state
 * — so this component stays free of state of its own and the panel above it
 * only ever learns the note the user actually settled on.
 */
export function AnnotationChip({
  annotation,
  editing,
  onEditStart,
  onEditCancel,
  onNoteCommit,
  onRemove,
}: AnnotationChipProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (editing) {
    const commit = () => {
      onNoteCommit(annotation.id, inputRef.current?.value ?? "");
    };

    return (
      <span className="badge badge-soft badge-sm h-auto gap-1 py-1">
        <input
          aria-label={`Note for ${shortSelector(annotation.selector)}`}
          className="input input-xs w-44"
          defaultValue={annotation.note}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onEditCancel();
            }
          }}
          placeholder="What should change here?"
          ref={(node) => {
            inputRef.current = node;
            node?.focus();
          }}
          type="text"
        />
        <button
          aria-label="Save this note"
          className="cursor-pointer opacity-70 transition-opacity hover:opacity-100"
          onClick={commit}
          type="button"
        >
          <Check className="h-3 w-3" />
        </button>
        <button
          aria-label="Stop editing this note"
          className="cursor-pointer opacity-70 transition-opacity hover:opacity-100"
          onClick={onEditCancel}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }

  return (
    <span className="badge badge-soft badge-sm h-auto gap-1 py-1">
      <button
        className="max-w-52 cursor-pointer truncate text-left"
        onClick={() => onEditStart(annotation.id)}
        title={annotation.text || annotation.selector}
        type="button"
      >
        {annotationLabel(annotation)}
      </button>
      <button
        aria-label="Remove this note"
        className="cursor-pointer opacity-70 transition-opacity hover:opacity-100"
        onClick={() => onRemove(annotation.id)}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
