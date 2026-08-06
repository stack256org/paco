"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useRememberedWorkspaceTab } from "./use-remembered-workspace-tab";

export type ActiveView = "chat" | "diff" | "file";
export type DiffScope = "uncommitted" | "branch";

/**
 * Which surface the right-hand workspace pane is showing.
 *
 * The pane replaced the old 18rem git drawer, so it owns everything that is
 * not the conversation: the running app, the file tree, the editor, and the
 * diff. `activeView` still describes the *left* column and now stays on
 * "chat" — opening a file no longer displaces the conversation.
 */
export type WorkspaceTab = "preview" | "files" | "changes";

type GitPanelContextValue = {
  /** Active surface in the right-hand workspace pane */
  workspaceTab: WorkspaceTab;
  setWorkspaceTab: (tab: WorkspaceTab) => void;

  /** Active view in the main content area (chat messages vs diff) */
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;

  /** Whether the user has explicitly closed the Changes tab */
  changesTabDismissed: boolean;
  setChangesTabDismissed: (dismissed: boolean) => void;

  /** File path to scroll to in the diff tab view */
  focusedDiffFile: string | null;
  setFocusedDiffFile: (file: string | null) => void;
  focusedDiffRequestId: number;

  /** Open the diff tab in the main content area, optionally focused on a file */
  openDiffToFile: (filePath: string) => void;

  /** Diff scope: "uncommitted" = uncommitted only, "branch" = all changes vs base */
  diffScope: DiffScope;
  setDiffScope: (scope: DiffScope) => void;

  /** Whether there are uncommitted changes that need attention */
  hasActionNeeded: boolean;
  setHasActionNeeded: (needed: boolean) => void;

  /** Number of changed files (for badge display on toggle button) */
  changesCount: number;
  setChangesCount: (count: number) => void;

  /** Whether there are committed (pushed) changes on the branch */
  hasCommittedChanges: boolean;
  setHasCommittedChanges: (has: boolean) => void;

  /** File path currently open in the file tab view */
  focusedFilePath: string | null;
  setFocusedFilePath: (file: string | null) => void;

  /** Whether the user has explicitly closed the File tab */
  fileTabDismissed: boolean;
  setFileTabDismissed: (dismissed: boolean) => void;

  /** Open a file in the main content area (non-diff view) */
  openFileTab: (filePath: string) => void;

  /** Share dialog trigger (set by per-chat page, called by header) */

  /** Ref to the DOM node where the git panel should be portaled into */
  panelPortalRef: RefObject<HTMLDivElement | null>;

  /**
   * Ref to the right-hand pane's slot.
   *
   * The pane is rendered by the chat content, which owns the dev-server and
   * editor hooks, and placed by the layout shell, which owns the split. The
   * portal is what lets those two stay where they belong.
   */
  workspacePortalRef: RefObject<HTMLDivElement | null>;

  /** Ref to the DOM node where header action buttons should be portaled into */
  headerActionsRef: RefObject<HTMLDivElement | null>;
};

const GitPanelContext = createContext<GitPanelContextValue | undefined>(
  undefined,
);

export function GitPanelProvider({ children }: { children: ReactNode }) {
  const [workspaceTab, setWorkspaceTab] = useRememberedWorkspaceTab("files");
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [focusedDiffFile, setFocusedDiffFile] = useState<string | null>(null);
  const [focusedDiffRequestId, setFocusedDiffRequestId] = useState(0);
  const [changesTabDismissed, setChangesTabDismissed] = useState(false);
  const [diffScope, setDiffScope] = useState<DiffScope>("uncommitted");
  const [hasActionNeeded, setHasActionNeeded] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [hasCommittedChanges, setHasCommittedChanges] = useState(false);
  const [focusedFilePath, setFocusedFilePath] = useState<string | null>(null);
  const [fileTabDismissed, setFileTabDismissed] = useState(false);
  const panelPortalRef = useRef<HTMLDivElement | null>(null);
  const workspacePortalRef = useRef<HTMLDivElement | null>(null);
  const headerActionsRef = useRef<HTMLDivElement | null>(null);

  /*
   * These move the *right* pane, not the left column.
   *
   * They used to set `activeView`, which swapped the conversation out for a
   * diff or a file — you lost your place in the thread to look at a file the
   * agent had just mentioned. With a pane of its own there is nothing to
   * trade: the file opens beside the conversation.
   */
  const openDiffToFile = useCallback(
    (filePath: string) => {
      setFocusedDiffFile(filePath);
      setFocusedDiffRequestId((prev) => prev + 1);
      setChangesTabDismissed(false);
      setWorkspaceTab("changes");
      // `setWorkspaceTab` is no longer a bare `useState` setter — it also writes
      // the choice to localStorage — so it has to be declared. It is wrapped in
      // `useCallback`, so this does not make the callback unstable.
    },
    [setWorkspaceTab],
  );

  const openFileTab = useCallback(
    (filePath: string) => {
      setFocusedFilePath(filePath);
      setFileTabDismissed(false);
      setWorkspaceTab("files");
    },
    [setWorkspaceTab],
  );

  const value = useMemo(
    () => ({
      workspaceTab,
      setWorkspaceTab,
      activeView,
      setActiveView,
      changesTabDismissed,
      setChangesTabDismissed,
      focusedDiffFile,
      setFocusedDiffFile,
      focusedDiffRequestId,
      openDiffToFile,
      diffScope,
      setDiffScope,
      hasActionNeeded,
      setHasActionNeeded,
      changesCount,
      setChangesCount,
      hasCommittedChanges,
      setHasCommittedChanges,
      focusedFilePath,
      setFocusedFilePath,
      fileTabDismissed,
      setFileTabDismissed,
      openFileTab,
      panelPortalRef,
      workspacePortalRef,
      headerActionsRef,
    }),
    [
      workspaceTab,
      activeView,
      changesTabDismissed,
      focusedDiffFile,
      focusedDiffRequestId,
      openDiffToFile,
      focusedFilePath,
      fileTabDismissed,
      openFileTab,
      diffScope,
      hasActionNeeded,
      changesCount,
      hasCommittedChanges,
      setWorkspaceTab,
    ],
  );

  return (
    <GitPanelContext.Provider value={value}>
      {children}
    </GitPanelContext.Provider>
  );
}

export function useGitPanel() {
  const context = useContext(GitPanelContext);
  if (!context) {
    throw new Error("useGitPanel must be used within a GitPanelProvider");
  }
  return context;
}
