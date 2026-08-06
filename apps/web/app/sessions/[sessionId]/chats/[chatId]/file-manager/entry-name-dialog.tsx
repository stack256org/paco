"use client";

import { useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { checkEntryName } from "./paths";

/**
 * Ask for a name, for New file, New folder and Rename alike.
 *
 * The name is checked before anything is sent, so an unusable name is
 * explained under the box the user is still typing in rather than arriving
 * back as a failed request.
 */
export function EntryNameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  initialValue = "",
  confirmLabel,
  busyLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  busyLabel: string;
  /** Resolves to a readable sentence when it failed, or null when it worked. */
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState(initialValue);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const handleSubmit = async () => {
    const check = checkEntryName(value);
    if (!check.ok) {
      setErrorMessage(check.message);
      return;
    }

    setIsRunning(true);
    setErrorMessage(null);
    try {
      setErrorMessage(await onSubmit(check.name));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setValue(initialValue);
          setErrorMessage(null);
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          className="mt-4 flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="label text-xs" htmlFor={inputId}>
            {label}
          </label>
          <input
            // Same words as the visible label above. The `for`/`id` pair is
            // built from `useId`, which static checkers cannot follow, so this
            // states the name outright rather than leaving it to inference.
            aria-label={label}
            aria-describedby={errorMessage ? errorId : undefined}
            aria-invalid={errorMessage !== null}
            autoComplete="off"
            className="input input-sm w-full font-mono"
            disabled={isRunning}
            id={inputId}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            value={value}
          />
          {errorMessage ? (
            <p className="text-error text-xs" id={errorId} role="alert">
              {errorMessage}
            </p>
          ) : (
            <p className="text-base-content/60 text-xs">
              Use a slash to put it inside a new folder, like{" "}
              <span className="font-mono">notes/today.md</span>.
            </p>
          )}

          <DialogFooter>
            <button
              className="btn btn-ghost btn-sm"
              disabled={isRunning}
              onClick={() => onOpenChange(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={isRunning || value.trim().length === 0}
              type="submit"
            >
              {isRunning ? busyLabel : confirmLabel}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
