"use client";

import {
  Archive,
  Check,
  ChevronsUpDown,
  GitPullRequest,
  Loader2,
  Plus,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { SessionWithUnread } from "@/hooks/use-sessions";
import { ArchivedWorkspacesSection } from "@/components/archived-workspaces-section";
import { archiveConfirmBody } from "@/lib/sessions/archive-copy";
import { groupSessionsByRepo } from "@/lib/sessions/group-by-repo";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Picks which workspace you are in, from the top bar.
 *
 * This replaces the 20rem sidebar that used to list every session down the left
 * edge. That list was permanently on screen to answer a question — "which
 * workspace am I in, and what else is there?" — that is asked once and then not
 * again for an hour, while the space it cost was taken from the work itself.
 *
 * The trigger answers the first half at a glance; the menu answers the second
 * half on demand, grouped by repository exactly as the sidebar was.
 */

function DiffCounts({ session }: { session: SessionWithUnread }) {
  const added = session.linesAdded ?? 0;
  const removed = session.linesRemoved ?? 0;

  if (added === 0 && removed === 0) {
    return null;
  }

  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>}
      {removed > 0 && <span className="text-error">-{removed}</span>}
    </span>
  );
}

/**
 * Why a row is worth looking at, as a word rather than only a colour.
 *
 * Returns null when there is nothing to say — a badge on every row is a badge
 * on none.
 */
function StatusBadge({ session }: { session: SessionWithUnread }) {
  if (session.hasStreaming) {
    return (
      <span className="badge badge-soft badge-xs gap-1">
        <Loader2 aria-hidden="true" className="size-2.5 animate-spin" />
        Working
      </span>
    );
  }

  if (session.prNumber && session.prStatus === "open") {
    return (
      <span className="badge badge-soft badge-xs gap-1">
        <GitPullRequest aria-hidden="true" className="size-2.5" />#
        {session.prNumber}
      </span>
    );
  }

  if (session.hasUnread) {
    return <span className="badge badge-soft badge-xs">Unread</span>;
  }

  return null;
}

export function WorkspaceSwitcher({
  sessions,
  archivedCount,
  activeSessionId,
  activeTitle,
  loading,
  onSelect,
  onPrefetch,
  onCreate,
  onArchive,
  onRestore,
}: {
  sessions: SessionWithUnread[];
  /** How many archived workspaces exist, so the section can hide when none do. */
  archivedCount: number;
  activeSessionId: string;
  /** Shown on the trigger; the live session title, which may lead `sessions`. */
  activeTitle: string;
  loading: boolean;
  onSelect: (session: SessionWithUnread) => void;
  onPrefetch: (session: SessionWithUnread) => void;
  onCreate: () => void;
  /** Archiving was a sidebar-row action; it has nowhere else to live. */
  onArchive: (session: SessionWithUnread) => void;
  /** Called once a workspace has been restored, to open it. */
  onRestore: (session: SessionWithUnread) => void;
}) {
  const menuId = useId();
  /*
   * Archiving stops the session's workspace, so it asks first.
   *
   * The same action already confirmed elsewhere in the app and not here, which
   * is the worst of both: a user learns it is safe to click and then loses a
   * running container to a misplaced one.
   */
  const [pendingArchive, setPendingArchive] =
    useState<SessionWithUnread | null>(null);
  const anchorName = `--${menuId.replace(/[^a-zA-Z0-9-]/g, "")}-anchor`;
  const groups = useMemo(() => groupSessionsByRepo(sessions), [sessions]);

  return (
    <>
      <button
        aria-label={`Workspace: ${activeTitle}. Switch workspace`}
        className="btn btn-ghost btn-sm max-w-[14rem] justify-start gap-1.5 px-2 font-medium"
        popoverTarget={menuId}
        style={{ anchorName } as React.CSSProperties}
        type="button"
      >
        <span className="truncate">{activeTitle}</span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 shrink-0 opacity-60"
        />
      </button>

      <div
        className="dropdown dropdown-start w-80 rounded-box border border-base-300 bg-base-100 shadow-lg"
        id={menuId}
        popover="auto"
        style={{ positionAnchor: anchorName } as React.CSSProperties}
      >
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {loading && sessions.length === 0 ? (
            <div className="space-y-1 p-2">
              <div className="skeleton h-7 w-full" />
              <div className="skeleton h-7 w-full" />
              <div className="skeleton h-7 w-4/5" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="px-3 py-6 text-center text-base-content/60 text-xs">
              No workspaces yet. Create one to start working with the agent.
            </p>
          ) : (
            groups.map((group) => (
              <ul className="menu menu-sm w-full p-0" key={group.id}>
                <li className="menu-title px-2 py-1 text-[10px] uppercase tracking-wider">
                  {group.label}
                </li>
                {group.sessions.map((session) => {
                  const isActive = session.id === activeSessionId;

                  return (
                    <li className="group/row" key={session.id}>
                      {/*
                        Two sibling controls, not one nested in the other:
                        selecting and archiving are different actions, and a
                        button inside a button is neither valid nor operable.
                      */}
                      <div className="flex items-center gap-1 p-0">
                        <button
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 rounded-field px-2 py-1.5 text-left",
                            isActive ? "menu-active" : "hover:bg-base-200",
                          )}
                          onClick={() => onSelect(session)}
                          onFocus={() => onPrefetch(session)}
                          onPointerEnter={() => onPrefetch(session)}
                          type="button"
                        >
                          <Check
                            aria-hidden="true"
                            className={cn(
                              "size-3.5 shrink-0",
                              isActive ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {session.title}
                          </span>
                          <StatusBadge session={session} />
                          <DiffCounts session={session} />
                        </button>
                        <button
                          aria-label={`Archive ${session.title}`}
                          className="btn btn-ghost btn-xs btn-square shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                          onClick={() => setPendingArchive(session)}
                          type="button"
                        >
                          <Archive aria-hidden="true" className="size-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ))
          )}
        </div>

        <ArchivedWorkspacesSection
          archivedCount={archivedCount}
          onOpen={onSelect}
          onRestored={onRestore}
          surface="menu"
        />

        <div className="border-base-300 border-t p-1">
          <button
            className="btn btn-ghost btn-sm w-full justify-start gap-2"
            onClick={onCreate}
            popoverTarget={menuId}
            popoverTargetAction="hide"
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            New workspace
          </button>
        </div>
      </div>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingArchive(null);
          }
        }}
        open={pendingArchive !== null}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Archive this workspace?</DialogTitle>
            <DialogDescription>
              {pendingArchive ? archiveConfirmBody(pendingArchive.title) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (pendingArchive) {
                  onArchive(pendingArchive);
                }
                setPendingArchive(null);
              }}
              size="sm"
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
