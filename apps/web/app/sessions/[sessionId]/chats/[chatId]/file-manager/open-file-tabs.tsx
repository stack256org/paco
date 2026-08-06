"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { fileName } from "./paths";

/**
 * The strip of open files across the top of the editor pane.
 *
 * A list of files, not an ARIA tablist: a tablist promises arrow-key movement
 * between tabs that each own a labelled panel, and these are two buttons per
 * file sharing one pane. Promising the behaviour without implementing it is
 * worse than not claiming it — as a list they are still reachable, labelled and
 * operable from the keyboard, which is what actually matters.
 *
 * Each file is a pair of buttons rather than one button with something
 * clickable inside it, because a button inside a button is not valid HTML.
 *
 * The strip scrolls sideways. Wrapping onto a second row would push the file
 * itself further down the pane every time another one was opened.
 */
export function OpenFileTabs({
  paths,
  activePath,
  dirtyPaths,
  onSelect,
  onClose,
}: {
  paths: readonly string[];
  activePath: string | null;
  /** Files with typing that is not on disk — marked, and said out loud. */
  dirtyPaths: readonly string[];
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const activeTabRef = useRef<HTMLLIElement | null>(null);

  /*
   * Once the strip scrolls, the file that just opened can be off the end of it,
   * and an unchanged strip reads as nothing having happened.
   */
  useEffect(() => {
    if (!activePath) return;
    activeTabRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activePath]);

  return (
    <ul
      aria-label="Open files"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-base-300 border-b px-1.5 py-1"
    >
      {paths.map((path) => {
        const name = fileName(path);
        const isActive = path === activePath;
        const isDirty = dirtyPaths.includes(path);

        return (
          <li
            className="join shrink-0"
            key={path}
            ref={isActive ? activeTabRef : undefined}
          >
            <button
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "btn join-item btn-ghost btn-xs max-w-40 gap-1.5 font-mono font-normal",
                isActive && "btn-active",
              )}
              onClick={() => onSelect(path)}
              title={path}
              type="button"
            >
              {/*
                A dot for the eye and a phrase for the screen reader. The dot is
                the presence of a mark rather than a shade of one, so reading it
                does not depend on telling two colours apart.
              */}
              {isDirty ? (
                <span
                  aria-hidden="true"
                  className="status status-warning status-sm shrink-0"
                />
              ) : null}
              <span className="truncate">{name}</span>
              {isDirty ? (
                <span className="sr-only">, not saved yet</span>
              ) : null}
            </button>

            <button
              aria-label={
                isDirty ? `Close ${name}, which is not saved` : `Close ${name}`
              }
              // Carries the active state too, so the pair reads as one tab
              // rather than a filled half and a transparent one.
              className={cn(
                "btn join-item btn-ghost btn-square btn-xs",
                isActive && "btn-active",
              )}
              onClick={() => onClose(path)}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
