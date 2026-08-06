"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import type { SessionWithUnread } from "@/hooks/use-sessions";
import {
  DELETE_WORKSPACE_COPY,
  deleteFailureMessage,
  deletedNotice,
  deleteWorkspaceAnywayConfirm,
  deleteWorkspaceConfirm,
} from "@/lib/sessions/delete-workspace-copy";
import {
  type DeleteWorkspaceOutcome,
  parseDeleteWorkspaceResponse,
} from "@/lib/sessions/delete-workspace-outcome";
import {
  ACTIVE_SESSIONS_KEY,
  ARCHIVED_SESSIONS_KEY,
} from "@/lib/sessions/session-cache-keys";
import { toast } from "@/lib/toast";

/**
 * Deleting a workspace, from the question to the empty space it leaves.
 *
 * All of it lives here because the interesting part is not the request. The
 * server refuses to delete a workspace holding work that exists nowhere else,
 * and that refusal is a *second question* rather than an error: what is unsaved
 * is named, and "Delete anyway" is its own button, pressed after reading
 * something the person did not know when they pressed the first one.
 *
 * Three things happen after a successful delete, and missing any one of them
 * leaves the workspace half-present:
 *
 * - It leaves the archived list it was deleted from.
 * - The live list's archived count drops, because that count is what the
 *   switcher's "Archived" section shows.
 * - If it is the workspace currently on screen, the page navigates away. Every
 *   route under it now 404s, so staying is not an option the user chose.
 */

/** The little a workspace has to be for this to delete it. */
type DeletableWorkspace = Pick<SessionWithUnread, "id" | "title">;

interface ArchivedListCache {
  sessions: SessionWithUnread[];
  archivedCount: number;
}

interface ActiveListCache {
  sessions: SessionWithUnread[];
  archivedCount?: number;
}

async function requestDelete(
  sessionId: string,
  force: boolean,
): Promise<DeleteWorkspaceOutcome> {
  try {
    const response = await fetch(
      `/api/sessions/${sessionId}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    );
    const body: unknown = await response.json().catch(() => null);
    return parseDeleteWorkspaceResponse(response.status, body);
  } catch (error) {
    return { kind: "failed", message: deleteFailureMessage(error) };
  }
}

export function useWorkspaceDeletion() {
  const { confirm, dialog } = useDestructiveConfirm();
  const { mutate: globalMutate } = useSWRConfig();
  const router = useRouter();
  const params = useParams<{ sessionId?: string }>();
  const routeSessionId =
    typeof params.sessionId === "string" ? params.sessionId : null;
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const forgetWorkspace = useCallback(
    async (sessionId: string) => {
      await globalMutate<ArchivedListCache>(
        ARCHIVED_SESSIONS_KEY,
        (current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.filter(
                  (session) => session.id !== sessionId,
                ),
                archivedCount: Math.max(current.archivedCount - 1, 0),
              }
            : current,
        { revalidate: false },
      );

      /*
       * The live list keeps the count the switcher renders, and it seeds itself
       * from a server prop — so a bare revalidation was not enough for the
       * neighbouring restore flow, and is not enough here either. The updater
       * fixes the number this call is certain about; the revalidation catches
       * anything else that moved.
       */
      await globalMutate<ActiveListCache>(
        ACTIVE_SESSIONS_KEY,
        (current) =>
          current
            ? {
                ...current,
                sessions: current.sessions.filter(
                  (session) => session.id !== sessionId,
                ),
                archivedCount: Math.max((current.archivedCount ?? 1) - 1, 0),
              }
            : current,
        { revalidate: true },
      );
    },
    [globalMutate],
  );

  const settleDeleted = useCallback(
    async (
      workspace: DeletableWorkspace,
      outcome: Extract<DeleteWorkspaceOutcome, { kind: "deleted" }>,
    ) => {
      await forgetWorkspace(workspace.id);

      const notice = deletedNotice(
        workspace.title,
        outcome.freedBytes,
        outcome.warnings,
      );
      toast.success(
        notice.title,
        notice.description ? { description: notice.description } : undefined,
      );

      if (workspace.id === routeSessionId) {
        router.push("/sessions");
      }
    },
    [forgetWorkspace, routeSessionId, router],
  );

  const deleteWorkspace = useCallback(
    async (workspace: DeletableWorkspace) => {
      /*
       * `run` does the delete while the dialog is still open, so the spinner
       * and any failure land on the surface that asked. The outcome is read
       * back through a function rather than the variable: assigning it inside
       * this closure is invisible to control-flow narrowing, which would
       * otherwise decide it is still null below.
       */
      let firstAttempt: DeleteWorkspaceOutcome | null = null;
      const readFirstAttempt = () => firstAttempt;

      setDeletingId(workspace.id);
      try {
        const first = deleteWorkspaceConfirm(workspace.title);
        await confirm({
          title: first.title,
          description: first.description,
          confirmLabel: first.confirmLabel,
          busyLabel: first.busyLabel,
          run: async () => {
            const outcome = await requestDelete(workspace.id, false);
            firstAttempt = outcome;

            if (outcome.kind === "failed") {
              return outcome.message;
            }
            if (outcome.kind === "deleted") {
              await settleDeleted(workspace, outcome);
            }
            // A refusal closes this dialog without an error, because it is not
            // one: the next question is a different question.
            return null;
          },
        });

        const attempt = readFirstAttempt();
        if (attempt?.kind !== "blocked") {
          return;
        }

        const anyway = deleteWorkspaceAnywayConfirm(
          workspace.title,
          attempt.unsavedWork,
        );
        await confirm({
          title: anyway.title,
          description: anyway.description,
          confirmLabel: anyway.confirmLabel,
          busyLabel: anyway.busyLabel,
          run: async () => {
            const outcome = await requestDelete(workspace.id, true);

            if (outcome.kind === "failed") {
              return outcome.message;
            }
            if (outcome.kind === "blocked") {
              return DELETE_WORKSPACE_COPY.stillRefused;
            }

            await settleDeleted(workspace, outcome);
            return null;
          },
        });
      } finally {
        setDeletingId(null);
      }
    },
    [confirm, settleDeleted],
  );

  return { deleteWorkspace, deletingId, deleteDialog: dialog };
}
