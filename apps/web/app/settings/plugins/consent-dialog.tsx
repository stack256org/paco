"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { Capability } from "@paco/plugin-kit";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConsentForm } from "./consent-form";

export interface ConsentGrantResult {
  ok: boolean;
  error?: string;
}

interface ConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginId: string;
  /** The manifest's declared capabilities — this dialog can only shrink this list, never add to it. */
  requested: Capability[];
  /** The manifest's exact `net:fetch` domain list, shown verbatim next to that capability. */
  netDomains: string[];
  /** Pre-checked on open — empty for a fresh install, the plugin's current grants for an update. */
  initialGrants: Capability[];
  onGrant: (grants: Capability[]) => Promise<ConsentGrantResult>;
  onGranted: () => void;
}

/**
 * The consent step: review what a plugin asked for, choose what to actually
 * grant, and enable it.
 *
 * Nothing this dialog submits can exceed `requested` — `ConsentForm` only
 * offers checkboxes for entries already in that list, and `setPluginGrants`
 * (`lib/db/plugins.ts`) enforces the same bound server-side regardless, so
 * this is belt-and-braces rather than the only guard. Submitting calls
 * `onGrant`, which the caller wires to `grantAndEnableAction` — the one
 * action that turns a reviewed, granted plugin into a running one.
 */
export function ConsentDialog({
  open,
  onOpenChange,
  pluginId,
  requested,
  netDomains,
  initialGrants,
  onGrant,
  onGranted,
}: ConsentDialogProps) {
  const [grants, setGrants] = useState<Capability[]>(initialGrants);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seeds whenever a new plugin's consent step opens — not on every
  // keystroke, since `grants` is deliberately absent from the dependency
  // list (same reasoning as `AgentEditorDialog`'s reset effect).
  useEffect(() => {
    if (!open) {
      return;
    }
    setGrants(initialGrants);
    setError(null);
  }, [open, initialGrants]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await onGrant(grants);
      if (result.ok) {
        onGranted();
        onOpenChange(false);
      } else {
        setError(result.error ?? "That grant could not be saved.");
      }
    } catch {
      setError("That grant could not be saved.");
    } finally {
      setSaving(false);
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Grant capabilities to {pluginId}</DialogTitle>
          <DialogDescription>
            Nothing runs until this step completes. Check only what this plugin
            needs — every grant can be changed later from this page.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <ConsentForm
            disabled={saving}
            grants={grants}
            netDomains={netDomains}
            onGrantsChange={setGrants}
            requested={requested}
          />

          {error ? (
            <div className="alert alert-error alert-soft" role="alert">
              <span>{error}</span>
            </div>
          ) : null}

          <DialogFooter>
            <button
              className="btn btn-ghost btn-sm"
              disabled={saving}
              onClick={() => onOpenChange(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={saving}
              type="submit"
            >
              {saving ? "Granting…" : "Grant and enable"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
