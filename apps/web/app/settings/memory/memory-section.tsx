"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import type { MemoryEntry } from "@/lib/memory/store";
import { MemoryEntryCard } from "./memory-entry-card";

export interface MemorySectionProps {
  title: string;
  description: string;
  entries: MemoryEntry[] | null;
  loadError: boolean;
  onRetry: () => void;
  onSave: (slug: string, body: string) => Promise<boolean>;
  onDelete: (slug: string) => void;
  deletingSlug: string | null;
  emptyMessage: string;
}

/**
 * This instance's memory entries: a heading, a loading/error state, and a
 * list of `MemoryEntryCard`s. Used to be rendered twice by
 * `MemoryPageContent` — once for a user's own memory, once for the
 * organisation's — before Phase C collapsed both into one instance scope;
 * the loading/empty/error chrome living here rather than at the call site
 * is a leftover of that, not a sign a second call site is coming back.
 */
export function MemorySection({
  title,
  description,
  entries,
  loadError,
  onRetry,
  onSave,
  onDelete,
  deletingSlug,
  emptyMessage,
}: MemorySectionProps) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-lg">{title}</h2>
        <p className="mt-1 text-base-content/60 text-sm">{description}</p>
      </div>

      {loadError ? (
        <div className="alert alert-error alert-soft" role="alert">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
          <span>This section couldn&apos;t be loaded.</span>
          <button className="btn btn-sm" onClick={onRetry} type="button">
            Try again
          </button>
        </div>
      ) : entries === null ? (
        <div className="flex justify-center py-8 text-base-content/60">
          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-base-300 border-dashed p-4 text-base-content/60 text-sm">
          {emptyMessage}
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <MemoryEntryCard
              deleting={deletingSlug === entry.slug}
              entry={entry}
              key={entry.slug}
              onDelete={() => onDelete(entry.slug)}
              onSave={(body) => onSave(entry.slug, body)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
