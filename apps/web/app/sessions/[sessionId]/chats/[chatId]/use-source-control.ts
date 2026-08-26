"use client";

import { useCallback, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "@/lib/toast";
import {
  type MutationKind,
  MUTATION_TARGETS_STAGED,
  runCommit,
  runFileMutation,
} from "./source-control-commands";
import type {
  ChangeRow,
  FileDiff,
  SelectedFile,
  SourceControlApi,
  WorkingTreeStatus,
} from "./source-control-contract";
import { fileRowKey } from "./source-control-contract";

/**
 * How often the panel re-reads git while it is on screen.
 *
 * The list has to survive three things happening behind it: the agent editing
 * files mid-turn, someone running git in the sandbox terminal, and a second
 * browser tab staging something. None of the three produces an event this
 * component could subscribe to, and only the first is even visible to the web
 * app — so a subscription would be a partial answer that looked like a whole
 * one, and would go quietly stale in the other two cases.
 *
 * A poll covers all three. Four seconds is chosen against the cost: this is one
 * `git status` in a worktree, it only runs while the Changes tab is the visible
 * tab, and SWR stops it entirely while the browser tab is in the background. On
 * top of it SWR revalidates on window focus, and every stage, unstage, discard
 * and commit revalidates immediately — so the poll is the backstop for changes
 * the person did not make, not the primary path.
 */
export const WORKING_TREE_POLL_MS = 4000;

type UseSourceControlInput = {
  api: SourceControlApi;
  chatId: string;
  /** False when the Changes tab is hidden or the sandbox is not connected. */
  active: boolean;
  /**
   * Asked before a Discard. Resolves true to go ahead. Supplied by the caller
   * so this hook does not have to own a dialog.
   */
  confirmDiscard: (files: ChangeRow[]) => Promise<boolean>;
};

export type SourceControl = {
  status: WorkingTreeStatus | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;

  selected: SelectedFile | null;
  select: (file: SelectedFile) => void;
  clearSelection: () => void;

  diff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;

  busyKeys: ReadonlySet<string>;
  stage: (files: ChangeRow[]) => void;
  unstage: (files: ChangeRow[]) => void;
  discard: (files: ChangeRow[]) => void;

  commitMessage: string;
  setCommitMessage: (value: string) => void;
  commit: () => void;
  committing: boolean;
};

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useSourceControl({
  api,
  chatId,
  active,
  confirmDiscard,
}: UseSourceControlInput): SourceControl {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  /*
   * Bumped after every mutation so the open diff re-fetches too.
   *
   * Staging a file does not change its path, so without this the diff key is
   * identical before and after and SWR hands back the cached patch — the row
   * moves to the other list and the diff beside it still shows the old side.
   */
  const [revision, setRevision] = useState(0);

  const {
    data: status,
    error: statusError,
    isLoading,
    isValidating,
    mutate,
  } = useSWR<WorkingTreeStatus>(
    active && chatId ? ["source-control", chatId] : null,
    () => api.getWorkingTreeStatus(chatId),
    {
      keepPreviousData: true,
      refreshInterval: WORKING_TREE_POLL_MS,
      revalidateOnFocus: true,
    },
  );

  const {
    data: diff,
    error: diffErrorValue,
    isLoading: diffLoading,
  } = useSWR<FileDiff>(
    selected && chatId
      ? [
          "source-control-diff",
          chatId,
          selected.path,
          selected.staged,
          revision,
        ]
      : null,
    () => {
      if (!selected) {
        throw new Error("No file selected");
      }
      return api.getFileDiff(chatId, selected.path, {
        staged: selected.staged,
      });
    },
    { keepPreviousData: false, revalidateOnFocus: false },
  );

  const refresh = useCallback(() => {
    void mutate();
    setRevision((value) => value + 1);
  }, [mutate]);

  /*
   * A ref, so the four action callbacks below stay referentially stable and a
   * list of rows does not re-render on every keystroke in the commit box.
   */
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const mutateFiles = useCallback(
    async (kind: MutationKind, files: ChangeRow[]) => {
      if (files.length === 0) {
        return;
      }
      const staged = MUTATION_TARGETS_STAGED[kind];
      const keys = files.map((file) => fileRowKey({ path: file.path, staged }));
      setBusyKeys((previous) => new Set([...previous, ...keys]));
      const { error } = await runFileMutation({
        api,
        chatId,
        kind,
        paths: files.map((file) => file.path),
      });
      if (error) {
        toast.error(error);
      }
      setBusyKeys((previous) => {
        const next = new Set(previous);
        for (const key of keys) {
          next.delete(key);
        }
        return next;
      });
      refreshRef.current();
    },
    [api, chatId],
  );

  const stage = useCallback(
    (files: ChangeRow[]) => {
      void mutateFiles("stage", files);
    },
    [mutateFiles],
  );

  const unstage = useCallback(
    (files: ChangeRow[]) => {
      void mutateFiles("unstage", files);
    },
    [mutateFiles],
  );

  const discard = useCallback(
    (files: ChangeRow[]) => {
      void (async () => {
        if (files.length === 0) {
          return;
        }
        const confirmed = await confirmDiscard(files);
        if (!confirmed) {
          return;
        }
        /*
         * The open diff closes first, not after.
         *
         * Discarding the file that is on screen leaves the pane describing a
         * comparison that no longer exists, and the refetch that follows would
         * ask git about a path it has just forgotten — so a failure would be
         * reported when nothing had gone wrong.
         */
        setSelected((current) =>
          current && files.some((file) => file.path === current.path)
            ? null
            : current,
        );
        await mutateFiles("discard", files);
      })();
    },
    [confirmDiscard, mutateFiles],
  );

  const commit = useCallback(() => {
    void (async () => {
      setCommitting(true);
      const { error, sha } = await runCommit({
        api,
        chatId,
        message: commitMessage,
      });
      if (error) {
        toast.error(error);
      } else {
        setCommitMessage("");
        setSelected(null);
        toast.success(
          sha ? `Committed as ${sha.slice(0, 7)}` : "Changes committed",
        );
      }
      setCommitting(false);
      refreshRef.current();
    })();
  }, [api, chatId, commitMessage]);

  return {
    status: status ?? null,
    loading: isLoading && !status,
    refreshing: isValidating,
    error: statusError
      ? messageFrom(statusError, "Could not read the workspace.")
      : null,
    refresh,

    selected,
    select: setSelected,
    clearSelection: useCallback(() => setSelected(null), []),

    diff: diff ?? null,
    diffLoading,
    diffError: diffErrorValue
      ? messageFrom(diffErrorValue, "Could not load this diff.")
      : null,

    busyKeys,
    stage,
    unstage,
    discard,

    commitMessage,
    setCommitMessage,
    commit,
    committing,
  };
}
