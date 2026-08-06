"use client";

import { Archive, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { useArchivedSessions } from "@/hooks/use-archived-sessions";
import type { SessionWithUnread } from "@/hooks/use-sessions";
import { useWorkspaceDeletion } from "@/hooks/use-workspace-deletion";
import {
  ARCHIVE_COPY,
  restoreFailureMessage,
} from "@/lib/sessions/archive-copy";
import { DELETE_WORKSPACE_COPY } from "@/lib/sessions/delete-workspace-copy";
import { getRepoGroupLabel } from "@/lib/sessions/group-by-repo";
import { toast } from "@/lib/toast";

/**
 * Where archived workspaces live: a collapsed section at the foot of the
 * workspace switcher, and again on the empty sessions page.
 *
 * Archiving used to be a one-way door — the button existed, the row then
 * disappeared from the only list in the product, and nothing anywhere led back
 * to it. A page of its own would have been the tidier thing to build and the
 * worse thing to use: you archive from the switcher, so the switcher is where
 * you look when you want it back, and a separate destination is one more place
 * a non-technical user has to know exists.
 *
 * It appears twice because the switcher is not always on screen. Archiving your
 * last workspace redirects to `/sessions`, which has no header and therefore no
 * switcher — the one moment you are most likely to want the thing you just
 * archived, and where the dead end was worst.
 *
 * It stays collapsed, and fetches nothing, until it is opened. Archived
 * workspaces cannot change while you are not looking at them, so paying for
 * that list on every page load would buy nothing.
 *
 * Permanent deletion lives here and nowhere else, deliberately. The live rows
 * in the switcher carry one hover control — Archive — and putting a second one
 * beside it would mean the reversible action and the irreversible one are a few
 * pixels apart on a row you are hovering in order to *switch* workspaces. The
 * cost of a slip there is the whole workspace. Archiving first is free, undoes
 * itself, and is already the step people take when they are finished with
 * something; deleting then happens on a list you have deliberately opened,
 * about a workspace you have already decided you are done with.
 */

function ArchivedRow({
  session,
  restoring,
  deleting,
  onOpen,
  onRestore,
  onDelete,
}: {
  session: SessionWithUnread;
  restoring: boolean;
  deleting: boolean;
  onOpen: (session: SessionWithUnread) => void;
  onRestore: (session: SessionWithUnread) => void;
  onDelete: (session: SessionWithUnread) => void;
}) {
  const repoLabel = getRepoGroupLabel(session);

  return (
    <li>
      {/*
        Sibling controls rather than one nested in the other, matching the
        live rows above: opening, restoring and deleting are different actions,
        and a button inside a button is neither valid nor operable.
      */}
      <div className="flex items-center gap-1 p-0">
        <button
          className="flex min-w-0 flex-1 flex-col items-start gap-0 rounded-field px-2 py-1.5 text-left hover:bg-base-200"
          disabled={deleting}
          onClick={() => onOpen(session)}
          type="button"
        >
          <span className="w-full truncate text-base-content/70">
            {session.title}
          </span>
          <span className="w-full truncate text-[10px] text-base-content/50">
            {repoLabel}
          </span>
        </button>
        <button
          className="btn btn-ghost btn-xs shrink-0"
          disabled={restoring || deleting}
          onClick={() => onRestore(session)}
          type="button"
        >
          {restoring ? (
            <>
              <span
                aria-hidden="true"
                className="loading loading-spinner loading-xs"
              />
              {ARCHIVE_COPY.restoringAction}
            </>
          ) : (
            ARCHIVE_COPY.restoreAction
          )}
        </button>
        {/*
          Icon-only, and shaped differently from the text button beside it, so
          the two never read as a pair of equivalent choices. It carries its
          own name for screen readers, and the colour is not the only signal:
          what it does is spelled out in the dialog before anything happens.
        */}
        <button
          aria-label={`${DELETE_WORKSPACE_COPY.rowAction} ${session.title}`}
          className="btn btn-ghost btn-square btn-xs shrink-0 text-error"
          disabled={restoring || deleting}
          onClick={() => onDelete(session)}
          type="button"
        >
          {deleting ? (
            <span
              aria-hidden="true"
              className="loading loading-spinner loading-xs"
            />
          ) : (
            <Trash2 aria-hidden="true" className="size-3" />
          )}
        </button>
      </div>
    </li>
  );
}

function ArchivedList({
  onOpen,
  onRestored,
}: {
  onOpen: (session: SessionWithUnread) => void;
  onRestored: (session: SessionWithUnread) => void;
}) {
  const { archivedSessions, loading, error, restoreSession } =
    useArchivedSessions();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const { deleteWorkspace, deletingId, deleteDialog } = useWorkspaceDeletion();

  const handleRestore = async (session: SessionWithUnread) => {
    setRestoringId(session.id);
    try {
      await restoreSession(session.id);
      onRestored(session);
    } catch (restoreError) {
      toast.error(restoreFailureMessage(restoreError));
    } finally {
      setRestoringId(null);
    }
  };

  if (loading && archivedSessions.length === 0) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        <div className="skeleton h-6 w-full" />
        <div className="skeleton h-6 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <p className="px-2 py-2 text-error text-xs">
        {ARCHIVE_COPY.sectionLoadFailed}
      </p>
    );
  }

  if (archivedSessions.length === 0) {
    return (
      <p className="px-2 py-2 text-base-content/60 text-xs">
        {ARCHIVE_COPY.sectionEmpty}
      </p>
    );
  }

  return (
    <>
      <p className="px-2 pb-1 text-base-content/60 text-xs">
        {ARCHIVE_COPY.sectionHint}
      </p>
      <ul className="menu menu-sm w-full p-0">
        {archivedSessions.map((session) => (
          <ArchivedRow
            deleting={deletingId === session.id}
            key={session.id}
            onDelete={deleteWorkspace}
            onOpen={onOpen}
            onRestore={handleRestore}
            restoring={restoringId === session.id}
            session={session}
          />
        ))}
      </ul>
      {/*
        The dialog is portalled to the document, so it is unaffected by living
        inside the switcher's popover — which light-dismisses the moment the
        confirm button is clicked, without unmounting this list or the promise
        it is waiting on.
      */}
      {deleteDialog}
    </>
  );
}

/**
 * The two places this section is mounted, and the chrome each one needs.
 *
 * Complete class strings picked by a literal, not assembled from parts: a class
 * name built at runtime is one Tailwind cannot see, and it is silently dropped
 * from the stylesheet.
 */
const SURFACE_CLASS = {
  /** Last block in the workspace switcher popover, above "New workspace". */
  menu: "border-base-300 border-t p-1",
  /** Standing on its own on the empty sessions page. */
  panel: "w-full max-w-md rounded-box border border-base-300 bg-base-100 p-1",
} as const;

export function ArchivedWorkspacesSection({
  archivedCount,
  surface,
  onOpen,
  onRestored,
}: {
  /** From the live session list, so the section can stay closed and empty. */
  archivedCount: number;
  surface: keyof typeof SURFACE_CLASS;
  onOpen: (session: SessionWithUnread) => void;
  onRestored: (session: SessionWithUnread) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (archivedCount <= 0) {
    return null;
  }

  return (
    <div className={SURFACE_CLASS[surface]}>
      <button
        aria-expanded={expanded}
        className="btn btn-ghost btn-sm w-full justify-start gap-2 font-normal"
        onClick={() => setExpanded((open) => !open)}
        type="button"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-60" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3.5 opacity-60" />
        )}
        <Archive aria-hidden="true" className="size-3.5 opacity-60" />
        <span className="flex-1 text-left">{ARCHIVE_COPY.sectionTitle}</span>
        <span className="badge badge-ghost badge-sm">{archivedCount}</span>
      </button>

      {expanded ? (
        <div className="pt-1">
          <ArchivedList onOpen={onOpen} onRestored={onRestored} />
        </div>
      ) : null}
    </div>
  );
}
