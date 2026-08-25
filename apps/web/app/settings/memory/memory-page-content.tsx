"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/hooks/use-session";
import type { MemoryEntry } from "@/lib/memory/store";
import { promoteMemoryAction } from "@/lib/memory/promote";
import { toast } from "@/lib/toast";
import {
  deleteOrgMemory,
  deleteUserMemory,
  editOrgMemory,
  editUserMemory,
  listOrgMemory,
  listUserMemory,
} from "./actions";
import { MemorySection } from "./memory-section";

/**
 * The interactive half of `/settings/memory`.
 *
 * A client component fetching its own data — same shape as
 * `AgentsPageContent` — so the user section, the org section, and every
 * mutation can update this component's own state without a full page
 * reload. `isAdmin` only decides whether the org section is *fetched and
 * rendered* here; the real gate is server-side, in `listOrgMemory` /
 * `editOrgMemory` / `deleteOrgMemory` (`requireAdmin`, see `actions.ts`).
 */
export function MemoryPageContent() {
  const { isAdmin } = useSession();

  const [userEntries, setUserEntries] = useState<MemoryEntry[] | null>(null);
  const [userLoadError, setUserLoadError] = useState(false);
  const [orgEntries, setOrgEntries] = useState<MemoryEntry[] | null>(null);
  const [orgLoadError, setOrgLoadError] = useState(false);

  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [promotingSlug, setPromotingSlug] = useState<string | null>(null);

  const requestIdRef = useRef(0);

  const loadUserMemory = useCallback(async () => {
    setUserLoadError(false);
    try {
      setUserEntries(await listUserMemory());
    } catch {
      toast.error("We couldn't load your memory.");
      setUserLoadError(true);
    }
  }, []);

  const loadOrgMemory = useCallback(async () => {
    setOrgLoadError(false);
    try {
      setOrgEntries(await listOrgMemory());
    } catch {
      toast.error("We couldn't load the organisation's memory.");
      setOrgLoadError(true);
    }
  }, []);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    void loadUserMemory();
    if (isAdmin) {
      void loadOrgMemory();
    } else if (requestIdRef.current === requestId) {
      setOrgEntries(null);
    }
  }, [isAdmin, loadUserMemory, loadOrgMemory]);

  async function handleSaveUser(slug: string, body: string): Promise<boolean> {
    const result = await editUserMemory(slug, body);
    if (result.success) {
      setUserEntries(
        (entries) =>
          entries?.map((entry) =>
            entry.slug === slug ? { ...entry, body, source: "manual" } : entry,
          ) ?? entries,
      );
      toast.success("Saved.");
      return true;
    }
    toast.error(result.error);
    return false;
  }

  async function handleSaveOrg(slug: string, body: string): Promise<boolean> {
    const result = await editOrgMemory(slug, body);
    if (result.success) {
      setOrgEntries(
        (entries) =>
          entries?.map((entry) =>
            entry.slug === slug ? { ...entry, body, source: "manual" } : entry,
          ) ?? entries,
      );
      toast.success("Saved.");
      return true;
    }
    toast.error(result.error);
    return false;
  }

  async function handleDeleteUser(slug: string) {
    setDeletingSlug(slug);
    const previous = userEntries;
    setUserEntries(
      (entries) => entries?.filter((entry) => entry.slug !== slug) ?? entries,
    );
    try {
      const result = await deleteUserMemory(slug);
      if (!result.success) {
        setUserEntries(previous);
        toast.error(result.error);
      }
    } catch {
      setUserEntries(previous);
      toast.error("That entry could not be deleted.");
    } finally {
      setDeletingSlug(null);
    }
  }

  async function handleDeleteOrg(slug: string) {
    setDeletingSlug(slug);
    const previous = orgEntries;
    setOrgEntries(
      (entries) => entries?.filter((entry) => entry.slug !== slug) ?? entries,
    );
    try {
      const result = await deleteOrgMemory(slug);
      if (!result.success) {
        setOrgEntries(previous);
        toast.error(result.error);
      }
    } catch {
      setOrgEntries(previous);
      toast.error("That entry could not be deleted.");
    } finally {
      setDeletingSlug(null);
    }
  }

  async function handlePromote(entry: MemoryEntry) {
    setPromotingSlug(entry.slug);
    try {
      const result = await promoteMemoryAction({
        title: entry.title,
        body: entry.body,
      });
      if (!result.ok) {
        toast.error(result.error);
      } else if (result.promoted) {
        toast.success("Promoted to org memory.");
        if (isAdmin) {
          void loadOrgMemory();
        }
      } else {
        toast.success("Proposal sent for an admin to review.");
      }
    } catch {
      toast.error("That proposal couldn't be sent.");
    } finally {
      setPromotingSlug(null);
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
          Project memory isn&apos;t shown here — it lives in the repo itself,
          versioned alongside the code it&apos;s about, at{" "}
          <code className="rounded bg-base-200 px-1 py-0.5 text-xs">
            .paco/memory/
          </code>
          .
        </p>
      </div>

      <MemorySection
        deletingSlug={deletingSlug}
        description="Preferences and conventions distilled from your own chats, plus anything you've written in by hand. Visible only to you."
        emptyMessage="No memory yet — it fills in as you use Paco."
        entries={userEntries}
        loadError={userLoadError}
        onDelete={(slug) => void handleDeleteUser(slug)}
        onPromote={(entry) => void handlePromote(entry)}
        onRetry={() => void loadUserMemory()}
        onSave={handleSaveUser}
        promotingSlug={promotingSlug}
        title="Your memory"
      />

      {isAdmin ? (
        <MemorySection
          deletingSlug={deletingSlug}
          description="Shared across the whole organisation. Only reaches here by explicit promotion — never written automatically."
          emptyMessage="No organisation memory yet."
          entries={orgEntries}
          loadError={orgLoadError}
          onDelete={(slug) => void handleDeleteOrg(slug)}
          onRetry={() => void loadOrgMemory()}
          onSave={handleSaveOrg}
          title="Organisation memory"
        />
      ) : null}
    </div>
  );
}
