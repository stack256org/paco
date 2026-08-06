"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceTab } from "./git-panel-context";

const STORAGE_KEY = "paco:workspace-tab";

const TABS: readonly WorkspaceTab[] = ["preview", "files", "changes"];

function isWorkspaceTab(value: string): value is WorkspaceTab {
  return (TABS as readonly string[]).includes(value);
}

/**
 * The workspace tab, remembered across reloads.
 *
 * Every reload used to land on Files regardless of where you were. That is a
 * small thing once and a constant annoyance in a session spent watching the
 * preview: refresh the page, lose your place, click back. Someone comparing the
 * app against their changes does that dozens of times an hour.
 *
 * The choice is remembered for the whole app rather than per chat. The tab is a
 * way of working — "I watch the preview" or "I read the diffs" — not a property
 * of one piece of work, and a per-chat memory would send you back to Files
 * every time you opened something new, which is the behaviour being fixed.
 *
 * It is read after mount, never during render: `localStorage` does not exist on
 * the server, and reading it while rendering would make the first client pass
 * disagree with the server's HTML.
 */
export function useRememberedWorkspaceTab(
  initial: WorkspaceTab = "files",
): [WorkspaceTab, (tab: WorkspaceTab) => void] {
  const [tab, setTab] = useState<WorkspaceTab>(initial);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && isWorkspaceTab(stored)) {
        setTab(stored);
      }
    } catch {
      // Private browsing, a disabled storage policy, a full quota. None of
      // these are worth a message: the default tab is a perfectly good answer.
    }
  }, []);

  const select = useCallback((next: WorkspaceTab) => {
    setTab(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // As above — the tab still changes, it just will not be there next time.
    }
  }, []);

  return [tab, select];
}
