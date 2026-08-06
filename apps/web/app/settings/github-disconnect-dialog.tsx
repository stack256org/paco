"use client";

import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirmation for removing the stored GitHub token.
 *
 * Disconnecting used to happen on the first click of a small outline button.
 * It is not a small action: every session in flight loses its ability to push,
 * open a pull request, or create a repository, and the token cannot be
 * recovered — it has to be created again on GitHub and pasted back in.
 *
 * Modelled on the revoke-all dialog in `admin/page.tsx` so the two destructive
 * actions in Settings look and behave the same way.
 */
export function GitHubDisconnectDialog({
  login,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: {
  readonly login: string | null | undefined;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-error" />
            Disconnect GitHub{login ? ` (${login})` : ""}?
          </DialogTitle>
          <DialogDescription className="space-y-3">
            <span className="block">
              Paco will forget the access token you pasted. Your code on GitHub
              is untouched, but Paco will no longer be able to save your work,
              open pull requests, or create repositories for you.
            </span>
            <span className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              Anything Paco is working on right now will fail when it tries to
              save. To reconnect you will need to paste a token again.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={busy} variant="outline">
              Keep it connected
            </Button>
          </DialogClose>
          <Button disabled={busy} onClick={onConfirm} variant="destructive">
            {busy ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            {busy ? "Disconnecting…" : "Disconnect GitHub"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
