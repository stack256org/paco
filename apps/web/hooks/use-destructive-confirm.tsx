"use client";

import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  createDestructiveConfirmQueue,
  type DestructiveConfirmQueue,
  type DestructiveConfirmRequest,
} from "./destructive-confirm-queue";

export type { DestructiveConfirmRequest };

/**
 * A yes/no question about something that cannot be taken back, asked in the
 * app's own dialog.
 *
 * Every one of these used to be `window.confirm`. That works, but it is the
 * browser's dialog, not Paco's: it ignores the theme, cannot name its buttons
 * anything but OK and Cancel, renders `\n\n` as the only formatting available,
 * and in some browsers offers "prevent this page from creating more dialogs",
 * which silently disables every later confirmation. On a destructive action
 * that is the worst possible failure — the guard disappears and the action
 * does not.
 *
 * It is a hook rather than a dialog per action because the question is
 * momentary: the caller `await`s an answer at the point of the decision, the
 * same shape `window.confirm` had, so the surrounding logic did not have to be
 * rewritten into callbacks to gain a real dialog.
 *
 * Not everything asked here is destructive. Compacting a chat and signing out
 * destroy nothing, but they are expensive or hard to walk back, so they ask the
 * same way — without the red button, which is reserved for deletion so that it
 * keeps meaning something.
 */
export function useDestructiveConfirm() {
  const [request, setRequest] = useState<DestructiveConfirmRequest | null>(
    null,
  );

  const queueRef = useRef<DestructiveConfirmQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = createDestructiveConfirmQueue(setRequest);
  }
  const queue = queueRef.current;

  const confirm = useCallback(
    (next: DestructiveConfirmRequest): Promise<boolean> => queue.ask(next),
    [queue],
  );

  const dialog = request ? (
    <ConfirmDialog
      busyLabel={request.busyLabel}
      cancelLabel={request.cancelLabel}
      confirmLabel={request.confirmLabel}
      description={request.description}
      destructive={request.destructive ?? true}
      onConfirm={async () => {
        // With `run`, the dialog stays put and owns the spinner and the error,
        // so a failure is answered on the surface that caused it rather than
        // somewhere the person has already looked away from.
        const failure = (await request.run?.()) ?? null;
        if (failure !== null) {
          return failure;
        }
        queue.settle(true);
        return null;
      }}
      onOpenChange={(open) => {
        if (!open) queue.settle(false);
      }}
      open
      title={request.title}
    />
  ) : null;

  return { confirm, dialog };
}
