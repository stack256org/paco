"use client";

import { useCallback, useState } from "react";
import type { WorkspaceEntryKind } from "@/app/api/sessions/[sessionId]/files/entry/route";
import {
  createEntry as createEntryRequest,
  deleteEntry as deleteEntryRequest,
  renameEntry as renameEntryRequest,
} from "./api";

/** A finished action: `null` when it worked, a readable sentence when it did not. */
export type ActionOutcome = string | null;

export type EntryActions = {
  create: (path: string, kind: WorkspaceEntryKind) => Promise<ActionOutcome>;
  rename: (from: string, to: string) => Promise<ActionOutcome>;
  remove: (path: string) => Promise<ActionOutcome>;
  isBusy: boolean;
};

/**
 * Create, rename and delete, each followed by a refresh of the tree.
 *
 * The refresh is awaited before the action reports success so the dialog that
 * triggered it closes onto an up-to-date list: closing first and refreshing
 * afterwards showed the file the user had just deleted, still sitting there.
 */
export function useEntryActions({
  sessionId,
  chatId,
  refreshFiles,
}: {
  sessionId: string;
  chatId: string;
  refreshFiles: () => Promise<void>;
}): EntryActions {
  const [isBusy, setIsBusy] = useState(false);

  const run = useCallback(
    async (request: () => Promise<{ ok: boolean; message?: string }>) => {
      setIsBusy(true);
      try {
        const result = await request();
        if (!result.ok) {
          return result.message ?? "Something went wrong. Try again.";
        }
        await refreshFiles();
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    [refreshFiles],
  );

  const create = useCallback(
    (path: string, kind: WorkspaceEntryKind) =>
      run(() => createEntryRequest({ sessionId, chatId }, path, kind)),
    [run, sessionId, chatId],
  );

  const rename = useCallback(
    (from: string, to: string) =>
      run(() => renameEntryRequest({ sessionId, chatId }, from, to)),
    [run, sessionId, chatId],
  );

  const remove = useCallback(
    (path: string) =>
      run(() => deleteEntryRequest({ sessionId, chatId }, path)),
    [run, sessionId, chatId],
  );

  return { create, rename, remove, isBusy };
}
