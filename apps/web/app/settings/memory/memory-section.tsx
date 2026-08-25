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
  /** Present only for the user section — see `MemoryEntryCard`. */
  onPromote?: (entry: MemoryEntry) => void;
  promotingSlug?: string | null;
}

/**
 * One scope's worth of memory entries: a heading, a loading/error state,
 * and a list of `MemoryEntryCard`s. Rendered twice by `MemoryPageContent` —
 * once for the caller's user memory (always) and once for org memory
 * (admin only) — so the loading/empty/error chrome lives here instead of
 * being duplicated at each call site.
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
  onPromote,
  promotingSlug,
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
              onPromote={onPromote ? () => onPromote(entry) : undefined}
              onSave={(body) => onSave(entry.slug, body)}
              promoting={promotingSlug === entry.slug}
            />
          ))}
        </div>
      )}
    </section>
  );
}
