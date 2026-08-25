"use client";

import { type FormEvent, useState } from "react";
import type { Capability } from "@paco/plugin-kit";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type InstallResult =
  | { ok: true; pluginId: string; requested: Capability[] }
  | { ok: false; error: string };

interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (source: string) => Promise<InstallResult>;
  /** Called after a successful fetch, with the REQUESTED capabilities — never grants anything itself. */
  onInstalled: (result: { pluginId: string; requested: Capability[] }) => void;
}

/**
 * Step one of installing a plugin: enter its source, fetch it, and validate
 * its manifest.
 *
 * A successful submit here only means a manifest was found and parsed
 * (`installPluginAction`'s own invariant — the plugin is registered
 * disabled, with no granted capabilities). `onInstalled` hands the
 * REQUESTED capabilities to the caller, which opens `ConsentDialog` next;
 * this dialog closes itself and holds no opinion about what happens after —
 * it never grants anything and never enables the plugin.
 */
export function InstallDialog({
  open,
  onOpenChange,
  onInstall,
  onInstalled,
}: InstallDialogProps) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (installing) {
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      const result = await onInstall(source.trim());
      if (result.ok) {
        onInstalled({ pluginId: result.pluginId, requested: result.requested });
        setSource("");
      } else {
        setError(result.error);
      }
    } catch {
      setError("That plugin could not be installed.");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install a plugin</DialogTitle>
          <DialogDescription>
            Fetches and validates the manifest only. Nothing runs, and no
            capability is granted, until you review and confirm the next step.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => void handleSubmit(event)}
        >
          {error ? (
            <div className="alert alert-error alert-soft" role="alert">
              <span>{error}</span>
            </div>
          ) : null}

          <div className="grid gap-2">
            <label className="label" htmlFor="plugin-source">
              Source
            </label>
            <input
              className="input input-sm w-full"
              disabled={installing}
              id="plugin-source"
              onChange={(event) => setSource(event.target.value)}
              placeholder="owner/repo, owner/repo#ref, or local:/abs/path"
              value={source}
            />
          </div>

          <DialogFooter>
            <button
              className="btn btn-ghost btn-sm"
              disabled={installing}
              onClick={() => onOpenChange(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={installing || source.trim().length === 0}
              type="submit"
            >
              {installing ? "Fetching…" : "Fetch manifest"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
