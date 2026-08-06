"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A yes/no question about something that cannot be taken back.
 *
 * The confirming button is labelled with the action ("Delete file"), never
 * "OK": someone skim-reading a dialog reads the buttons, so the buttons have
 * to be the sentence.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Resolves to a readable sentence when it failed, or null when it worked. */
  onConfirm: () => Promise<string | null> | string | null;
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const handleConfirm = async () => {
    setIsRunning(true);
    setErrorMessage(null);
    try {
      const result = await onConfirm();
      setErrorMessage(result);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null);
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {errorMessage ? (
          <p className="mt-3 text-error text-sm" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <DialogFooter>
          <button
            className="btn btn-ghost btn-sm"
            disabled={isRunning}
            onClick={() => onOpenChange(false)}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={cn(
              "btn btn-sm",
              destructive ? "btn-error" : "btn-primary",
            )}
            disabled={isRunning}
            onClick={() => void handleConfirm()}
            type="button"
          >
            {isRunning ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
