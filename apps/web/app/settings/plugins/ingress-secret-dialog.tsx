"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface IngressSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginId: string;
  secret: string;
}

/** Copies `text`, flashing a checkmark for a moment — same shape as `download-diff-dialog.tsx`'s `useCopy`. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 1600);
    });
  }, []);

  return { copied, copy };
}

/**
 * A one-time reveal of a plugin's freshly-minted `channels:ingress` secret.
 *
 * `grantAndEnableAction` (`./actions.ts`) returns this plaintext exactly
 * once — the moment `ensurePluginIngressSecret` mints it — and never again:
 * no read path (`getPlugin`/`listPlugins`) exposes it a second time, only
 * the sealed column. So this dialog is the only place in the product this
 * value is ever shown, which is also why it warns rather than just displays
 * it: closing this without copying it means asking the plugin author (or
 * re-triggering a mint some other way) to get it back.
 */
export function IngressSecretDialog({
  open,
  onOpenChange,
  pluginId,
  secret,
}: IngressSecretDialogProps) {
  const { copied, copy } = useCopy();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save {pluginId}&apos;s ingress secret</DialogTitle>
          <DialogDescription>
            This is the only time this secret is shown. It authenticates inbound
            webhook requests for this plugin — copy it now.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="alert alert-warning alert-soft" role="alert">
            <span>
              You won&apos;t see this value again. If you lose it, remove and
              re-enable the plugin to mint a new one.
            </span>
          </div>

          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md border border-base-300 bg-base-200/50 px-2 py-1.5 text-xs">
              {secret}
            </code>
            <button
              aria-label={copied ? "Copied" : "Copy secret"}
              className="btn btn-ghost btn-sm"
              onClick={() => copy(secret)}
              type="button"
            >
              {copied ? (
                <Check aria-hidden="true" className="size-4" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>

          <div className="space-y-1 text-base-content/60 text-xs">
            <p>
              Send inbound webhooks to{" "}
              <code>
                /api/channels/{pluginId}/
                <span className="italic">&lt;channel&gt;</span>
              </code>
              , with this secret in the <code>x-paco-channel-secret</code>{" "}
              header.
            </p>
          </div>
        </div>

        <DialogFooter>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            Done
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
