"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { fileName } from "./paths";

/**
 * Work typed into the editor that is not on disk yet.
 *
 * It is a list of files rather than a single flag because several tabs can be
 * open with unsaved typing at once, and the questions worth asking are about
 * one file at a time: closing *this* tab, cancelling *this* edit.
 *
 * Carrying the `discard` callback alongside the paths, rather than the paths
 * alone, is what makes the warning honest: when someone chooses to discard, the
 * draft is actually thrown away. A list-only guard would let the same unsaved
 * text reappear the next time they opened the file, after being told it was
 * gone.
 */
type UnsavedWork = {
  /** Every file with typing that is not on disk. */
  paths: readonly string[];
  /** Throw one file's typing away. */
  discard: (path: string) => void;
};

const NOTHING_UNSAVED: UnsavedWork = { paths: [], discard: () => undefined };

type UnsavedChangesValue = {
  /** Report (or clear) the files with unsaved work. */
  setUnsavedWork: (work: UnsavedWork) => void;
  /**
   * Do something that would throw typed work away. Runs straight away when
   * there is nothing to lose, and otherwise asks first.
   *
   * `path` narrows the question to one file — closing its tab, deleting it.
   * Leave it out for something that abandons the editor as a whole, such as
   * switching the workspace pane to Preview.
   */
  guard: (action: () => void, path?: string) => void;
};

const UnsavedChangesContext = createContext<UnsavedChangesValue | undefined>(
  undefined,
);

/**
 * The sentence the dialog opens with.
 *
 * Naming the file matters once several can be unsaved at once: "your changes"
 * is not enough to decide with when you have three tabs on the go.
 */
function describeLoss(paths: readonly string[]): string {
  const only = paths.length === 1 ? paths[0] : undefined;
  const what = only
    ? `The changes you typed in ${fileName(only)}`
    : "The changes you typed";
  return `${what} haven't been saved. If you carry on, they'll be lost and you can't get them back.`;
}

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [hasUnsavedWork, setHasUnsavedWork] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    run: () => void;
    /** The files this action would discard, so the dialog can name them. */
    paths: readonly string[];
  } | null>(null);

  /*
   * The ref is what `guard` reads. Reading state instead would make `guard`
   * change identity on every edit, and any consumer holding an older copy —
   * a tab button in a memoized row, say — would still be running the version
   * that believed there was nothing to lose.
   *
   * Only the *fact* of unsaved work is React state. The list changes on every
   * keystroke, and re-rendering this whole subtree per keystroke to store it
   * would be paid for by the person typing.
   */
  const unsavedWorkRef = useRef<UnsavedWork>(NOTHING_UNSAVED);

  const setUnsavedWork = useCallback((work: UnsavedWork) => {
    unsavedWorkRef.current = work;
    setHasUnsavedWork(work.paths.length > 0);
  }, []);

  const guard = useCallback((action: () => void, path?: string) => {
    const { paths } = unsavedWorkRef.current;
    const atRisk =
      path === undefined ? paths : paths.filter((open) => open === path);

    if (atRisk.length === 0) {
      action();
      return;
    }
    setPendingAction({ run: action, paths: atRisk });
  }, []);

  // Closing the tab, reloading, or following a link out is the one route away
  // from here that React cannot intercept, so the browser's own prompt covers
  // it. It only appears while there is genuinely something to lose.
  useEffect(() => {
    if (!hasUnsavedWork) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedWork]);

  const value = useMemo(
    () => ({ setUnsavedWork, guard }),
    [setUnsavedWork, guard],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <ConfirmDialog
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        description={describeLoss(pendingAction?.paths ?? [])}
        destructive
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          if (!action) return null;

          for (const path of action.paths) {
            unsavedWorkRef.current.discard(path);
          }
          action.run();
          return null;
        }}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null);
        }}
        open={pendingAction !== null}
        title="Leave without saving?"
      />
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges(): UnsavedChangesValue {
  const context = useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error(
      "useUnsavedChanges must be used within an UnsavedChangesProvider",
    );
  }
  return context;
}

/**
 * Keep the guard in step with the editor's unsaved files.
 *
 * Unmounting clears the list: an editor that is no longer on screen has no work
 * to lose, and leaving the list set would block every later navigation with a
 * dialog about a file nobody can see.
 */
export function useReportUnsavedWork(
  dirtyPaths: readonly string[],
  discard: (path: string) => void,
) {
  const { setUnsavedWork } = useUnsavedChanges();

  useEffect(() => {
    setUnsavedWork({ paths: dirtyPaths, discard });
    return () => setUnsavedWork(NOTHING_UNSAVED);
  }, [dirtyPaths, discard, setUnsavedWork]);
}
