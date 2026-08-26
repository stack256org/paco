"use client";

import { Check, Loader2, Pencil, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { MemoryEntry } from "@/lib/memory/store";

export interface MemoryEntryCardProps {
  entry: MemoryEntry;
  /** Persists the edited body. Resolves to whether the save succeeded. */
  onSave: (body: string) => Promise<boolean>;
  onDelete: () => void;
  deleting: boolean;
  /**
   * Present only on a user-scope card — org entries are already at the top
   * of the promotion chain, so there is nothing further for them to
   * propose.
   */
  onPromote?: () => void;
  promoting?: boolean;
}

/**
 * One memory entry: title, source badge, and its body — either as read-only
 * text or, once "Edit" is clicked, an inline textarea saved in place.
 *
 * Shared between the user and org sections of `/settings/memory` (see
 * `memory-section.tsx`); `onPromote` is the only prop that differs between
 * them, present solely on user-scope cards.
 */
export function MemoryEntryCard({
  entry,
  onSave,
  onDelete,
  deleting,
  onPromote,
  promoting,
}: MemoryEntryCardProps) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(entry.body);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    const ok = await onSave(body);
    setSaving(false);
    if (ok) {
      setEditing(false);
    }
  }

  function handleCancel() {
    setBody(entry.body);
    setEditing(false);
  }

  return (
    <div className="rounded-lg border border-base-300 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-medium">{entry.title}</h3>
          <div className="mt-0.5 flex items-center gap-2 text-base-content/60 text-xs">
            <span className="badge badge-soft badge-sm">{entry.source}</span>
            <span>
              Updated {new Date(entry.updatedAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {onPromote ? (
            <button
              aria-label={`Propose "${entry.title}" for org memory`}
              className="btn btn-ghost btn-sm"
              disabled={promoting}
              onClick={onPromote}
              type="button"
            >
              {promoting ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Sparkles aria-hidden="true" className="size-4" />
              )}
            </button>
          ) : null}
          {editing ? null : (
            <button
              aria-label={`Edit "${entry.title}"`}
              className="btn btn-ghost btn-sm"
              onClick={() => setEditing(true)}
              type="button"
            >
              <Pencil aria-hidden="true" className="size-4" />
            </button>
          )}
          <button
            aria-label={`Delete "${entry.title}"`}
            className="btn btn-ghost btn-sm"
            disabled={deleting}
            onClick={onDelete}
            type="button"
          >
            {deleting ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          <textarea
            aria-label={`Edit the body of "${entry.title}"`}
            className="textarea w-full"
            disabled={saving}
            onChange={(event) => setBody(event.target.value)}
            rows={4}
            value={body}
          />
          <div className="flex justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm"
              disabled={saving}
              onClick={handleCancel}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={saving}
              onClick={() => void handleSave()}
              type="button"
            >
              {saving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Check aria-hidden="true" className="size-4" />
              )}
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-base-content/80 text-sm">
          {entry.body}
        </p>
      )}
    </div>
  );
}
