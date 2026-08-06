"use client";

import { ArrowLeft, FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one row of controls that is always on screen, whether the user is
 * looking at the list or at a file.
 *
 * It stays put on purpose: New file means the same thing in both places, and a
 * toolbar that appears and disappears is a toolbar people stop looking for.
 */
export function FileManagerToolbar({
  onShowFileList,
  onNewFile,
  onNewFolder,
  onRefresh,
  isRefreshing,
  disabled,
}: {
  /**
   * Uncover the file list. Only meaningful on a narrow screen, where the open
   * file sits on top of the list instead of beside it.
   */
  onShowFileList?: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-base-300 border-b px-1.5 py-1">
      {/*
        Hidden at the width where the list is already on screen.
        It used to read "All files" and stay put, which on a wide screen meant a
        button offering to show you a list you were looking at — and pressing it
        closed the file for no reason anyone could name. `sm:hidden` matches the
        breakpoint the two panes split at, so it is on screen exactly when it
        has something to do, and out of the tab order the rest of the time.
      */}
      {onShowFileList ? (
        <button
          className="btn btn-ghost btn-xs gap-1.5 sm:hidden"
          onClick={onShowFileList}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Files
        </button>
      ) : null}

      <button
        className="btn btn-ghost btn-xs gap-1.5"
        disabled={disabled}
        onClick={onNewFile}
        type="button"
      >
        <FilePlus aria-hidden="true" className="size-3.5" />
        New file
      </button>

      <button
        className="btn btn-ghost btn-xs gap-1.5"
        disabled={disabled}
        onClick={onNewFolder}
        type="button"
      >
        <FolderPlus aria-hidden="true" className="size-3.5" />
        New folder
      </button>

      <button
        aria-label="Refresh the list of files"
        className="btn btn-ghost btn-xs btn-square ml-auto"
        disabled={disabled || isRefreshing}
        onClick={onRefresh}
        title="Refresh the list of files"
        type="button"
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("size-3.5", isRefreshing && "animate-spin")}
        />
      </button>
    </div>
  );
}
