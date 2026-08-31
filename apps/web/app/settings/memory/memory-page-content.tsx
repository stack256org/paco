"use client";

import { useCallback, useEffect, useState } from "react";
import type { MemoryEntry } from "@/lib/memory/store";
import { toast } from "@/lib/toast";
import {
  deleteInstanceMemory,
  editInstanceMemory,
  listInstanceMemory,
} from "./actions";
import { MemorySection } from "./memory-section";

/**
 * The interactive half of `/settings/memory`.
 *
 * A client component fetching its own data — same shape as
 * `AgentsPageContent` — so this instance's memory and every mutation can
 * update this component's own state without a full page reload.
 *
 * Used to render a second, organisation-wide section alongside this one,
 * bridged by an explicit "promote" action. Phase C removed application-level
 * identity, which collapsed user and organisation memory into the same
 * instance scope — there is nothing left on the other side of that bridge to
 * promote into, so this page shows one list now.
 */
export function MemoryPageContent() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const loadMemory = useCallback(async () => {
    setLoadError(false);
    try {
      setEntries(await listInstanceMemory());
    } catch {
      toast.error("We couldn't load memory.");
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  async function handleSave(slug: string, body: string): Promise<boolean> {
    const result = await editInstanceMemory(slug, body);
    if (result.success) {
      setEntries(
        (current) =>
          current?.map((entry) =>
            entry.slug === slug ? { ...entry, body, source: "manual" } : entry,
          ) ?? current,
      );
      toast.success("Saved.");
      return true;
    }
    toast.error(result.error);
    return false;
  }

  async function handleDelete(slug: string) {
    setDeletingSlug(slug);
    const previous = entries;
    setEntries(
      (current) => current?.filter((entry) => entry.slug !== slug) ?? current,
    );
    try {
      const result = await deleteInstanceMemory(slug);
      if (!result.success) {
        setEntries(previous);
        toast.error(result.error);
      }
    } catch {
      setEntries(previous);
      toast.error("That entry could not be deleted.");
    } finally {
      setDeletingSlug(null);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Memory</h1>
        <p className="mt-1 text-base-content/60 text-sm">
          Notes distilled from your chats, kept as plain markdown you can read,
          edit, or delete at any time.
        </p>
        <p className="mt-2 text-base-content/60 text-sm">
          Project memory isn&apos;t shown here — it lives in the session&apos;s
          own checkout, at{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs">
            .paco/memory/
          </code>
          . Paco writes and reads it there but never commits it, so it stays
          untracked and local to that checkout. Commit it yourself if you want
          it shared and reviewable alongside the code it&apos;s about.
        </p>
      </div>

      <MemorySection
        deletingSlug={deletingSlug}
        description="Preferences and conventions distilled from your chats, plus anything you've written in by hand."
        emptyMessage="No memory yet — it fills in as you use Paco."
        entries={entries}
        loadError={loadError}
        onDelete={(slug) => void handleDelete(slug)}
        onRetry={() => void loadMemory()}
        onSave={handleSave}
        title="Memory"
      />
    </div>
  );
}
