"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type { WorkspaceFileContentResponse } from "@/app/api/sessions/[sessionId]/files/content/route";
import { FetchError, fetcherNoStore } from "@/lib/swr";
import { saveFile } from "./api";
import {
  type DraftsByPath,
  dirtyDraftPaths,
  discardDraft as discardDraftAt,
  draftAt,
  moveDraft as moveDraftTo,
  NO_DRAFTS,
  setDraftText,
  startDraft,
} from "./drafts";
import { fileContentKey, hasUnsavedChanges } from "./paths";

/**
 * Why a file could not be put on screen.
 *
 * The API already answers with a readable sentence, so this exists only to
 * decide what to offer alongside it: a retry is pointless for a file that will
 * always be too big, and an Edit button is wrong for something that is not
 * text.
 */
export type FileOpenIssue =
  | "too-large"
  | "not-text"
  | "missing"
  | "unavailable"
  | "unknown";

function classifyOpenIssue(error: unknown): FileOpenIssue {
  if (!(error instanceof FetchError)) return "unknown";
  if (error.status === 413) return "too-large";
  if (error.status === 404) return "missing";
  // The content route's 400s are all "this isn't a text file we can show":
  // a directory, a device, a binary, or a path we could not resolve.
  if (error.status === 400) return "not-text";
  if (error.status === 401 || error.status === 403 || error.status === 409) {
    return "unavailable";
  }
  if (error.status >= 500) return "unavailable";
  return "unknown";
}

/** A save that failed, and the file it was for. */
type SaveFailure = { path: string; message: string };

export type FileEditor = {
  content: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  reload: () => void;
  issue: FileOpenIssue | null;
  issueMessage: string | null;
  /** The open file's draft — non-null exactly while its textarea is showing. */
  draft: string | null;
  setDraft: (text: string) => void;
  /** Whether the open file has typing that is not on disk. */
  isDirty: boolean;
  /** Every file with typing that is not on disk, open tab or not. */
  dirtyPaths: readonly string[];
  startEditing: () => void;
  /** Throw one file's draft away without asking — the guard has already asked. */
  discardDraft: (path: string) => void;
  /** Keep a draft with its file across a rename. */
  moveDraft: (from: string, to: string) => void;
  save: () => Promise<void>;
  isSaving: boolean;
  saveError: string | null;
};

/**
 * Read the file that is on screen, and hold the edits in progress for every
 * file that has one.
 *
 * Only the open file is fetched — a background tab's text is already in the
 * SWR cache from when it was opened, and its draft is right here — so a strip
 * of ten tabs is still one request per file, once.
 *
 * The read shares its SWR key with the read-only file view, so opening a file
 * fetches it once and a save updates both at the same moment.
 */
export function useFileEditor({
  sessionId,
  chatId,
  path,
  onSaved,
}: {
  sessionId: string;
  chatId: string;
  /** The file on screen: the active tab, or `null` for none. */
  path: string | null;
  /** Called after a successful save, to bring the tree back in step. */
  onSaved?: () => void;
}): FileEditor {
  const key = useMemo(
    () => fileContentKey(sessionId, chatId, path),
    [sessionId, chatId, path],
  );

  const { data, error, isLoading, isValidating, mutate } =
    useSWR<WorkspaceFileContentResponse>(key, fetcherNoStore, {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    });

  const [drafts, setDrafts] = useState<DraftsByPath>(NO_DRAFTS);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  /*
   * Everything below reads the draft for `path` out of the map rather than
   * holding one draft and clearing it on the way past. That is what lets
   * someone type in A, look at B, and come back to their own words in A — and
   * it means the textarea can never show A's text under B's name, not even for
   * the one render before an effect would have run.
   */
  const draft = draftAt(drafts, path);
  const dirtyPaths = useMemo(() => dirtyDraftPaths(drafts), [drafts]);

  const content = data?.content ?? null;

  const setDraft = useCallback(
    (text: string) => {
      if (path === null) return;
      setDrafts((current) => setDraftText(current, path, text));
    },
    [path],
  );

  const startEditing = useCallback(() => {
    if (path === null || content === null) return;
    setSaveFailure(null);
    setDrafts((current) => startDraft(current, path, content));
  }, [path, content]);

  const discardDraft = useCallback((target: string) => {
    setDrafts((current) => discardDraftAt(current, target));
    setSaveFailure((current) => (current?.path === target ? null : current));
  }, []);

  const moveDraft = useCallback((from: string, to: string) => {
    setDrafts((current) => moveDraftTo(current, from, to));
  }, []);

  const reload = useCallback(() => {
    void mutate();
  }, [mutate]);

  const save = useCallback(async () => {
    if (!(path && draft)) return;

    // The file being written is captured here rather than read back after the
    // await: the user is free to switch tabs while the request is in flight.
    const target = path;
    setSavingPath(target);
    setSaveFailure(null);
    const result = await saveFile({ sessionId, chatId }, target, draft.text);
    setSavingPath(null);

    if (!result.ok) {
      // The draft is deliberately kept: a failed save must never be the moment
      // someone's typing disappears.
      setSaveFailure({ path: target, message: result.message });
      return;
    }

    const savedText = draft.text;
    setDrafts((current) => discardDraftAt(current, target));
    // Publish what we just wrote instead of re-reading it, so the file view
    // switches straight to the saved text with no flash of the old contents.
    // `mutate` is bound to this file's key, so a tab switch mid-save cannot
    // land these bytes on another file.
    await mutate(
      { path: target, content: savedText, size: result.data.size },
      { revalidate: false },
    );
    onSaved?.();
  }, [path, draft, sessionId, chatId, mutate, onSaved]);

  return {
    content,
    isLoading,
    isRefreshing: isValidating && !isLoading,
    reload,
    issue: error ? classifyOpenIssue(error) : null,
    issueMessage: error instanceof Error ? error.message : null,
    draft: draft?.text ?? null,
    setDraft,
    isDirty: hasUnsavedChanges(draft?.base ?? null, draft?.text ?? null),
    dirtyPaths,
    startEditing,
    discardDraft,
    moveDraft,
    save,
    isSaving: savingPath !== null && savingPath === path,
    saveError: saveFailure?.path === path ? saveFailure.message : null,
  };
}
