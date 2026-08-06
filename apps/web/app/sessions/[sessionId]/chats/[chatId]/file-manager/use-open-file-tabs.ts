"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { closeTab, neighbourTab, openTab, renameTab } from "./tab-set";

export type OpenFileTabsController = {
  /** The open files, in the order they were opened. */
  paths: readonly string[];
  /** Bring an already-open file back to the front. */
  select: (path: string) => void;
  /** Close one file, moving to a neighbour if it was the one on screen. */
  close: (path: string) => void;
  /** Follow a renamed file, keeping its place and its focus. */
  rename: (from: string, to: string) => void;
};

/**
 * Which files are open in the editor pane.
 *
 * The active file is not held here: the rest of the app already agrees on one
 * open file (the workspace pane's own file view reads it, and the chat shows a
 * tab for it), so this hook tracks the *other* open files around it and hands
 * the active one back through `setActivePath`.
 */
export function useOpenFileTabs({
  activePath,
  setActivePath,
}: {
  activePath: string | null;
  setActivePath: (path: string | null) => void;
}): OpenFileTabsController {
  const [paths, setPaths] = useState<readonly string[]>([]);

  /*
   * Tabs follow the active file rather than the click that opened it.
   *
   * A file gets opened from three places — this pane's tree, the changed-files
   * list under Changes, and the file links in the conversation — and only one
   * of them is ours to wrap. Watching the path itself catches all three, so no
   * route into the editor can leave a file open with no tab for it.
   *
   * `openTab` returns the same array when the file is already open, so this
   * settles after one render instead of looping.
   */
  useEffect(() => {
    if (!activePath) return;
    setPaths((current) => openTab(current, activePath));
  }, [activePath]);

  const select = useCallback(
    (path: string) => setActivePath(path),
    [setActivePath],
  );

  const close = useCallback(
    (path: string) => {
      // Ordered so the pane never renders a file that has no tab: the next file
      // is chosen from the strip as it still is, before the tab leaves it.
      if (path === activePath) setActivePath(neighbourTab(paths, path));
      setPaths((current) => closeTab(current, path));
    },
    [paths, activePath, setActivePath],
  );

  const rename = useCallback(
    (from: string, to: string) => {
      setPaths((current) => renameTab(current, from, to));
      if (activePath === from) setActivePath(to);
    },
    [activePath, setActivePath],
  );

  return useMemo(
    () => ({ paths, select, close, rename }),
    [paths, select, close, rename],
  );
}
