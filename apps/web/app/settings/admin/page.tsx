"use client";

import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "@/lib/toast";
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
import { revokeAllGitHubTokens } from "@/lib/admin/actions";
import { CertificateSection } from "./certificate-section";
import { DomainSection } from "./domain-section";
import { StorageSection } from "./storage-section";

function AdminPageContent() {
  const [revokeTarget, setRevokeTarget] = useState<"github" | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setIsRevoking(true);

    try {
      if (revokeTarget === "github") {
        const result = await revokeAllGitHubTokens();
        if (result.success) {
          toast.success("GitHub connections deleted", {
            description: `Removed ${result.deletedConnections ?? 0} stored credential(s). Users can revoke the tokens themselves on GitHub.`,
          });
        } else {
          toast.error(result.error ?? "Failed to delete GitHub connections");
        }
      }
    } catch {
      // Deliberately does not promise nothing changed: this catch also covers a
      // connection dropped partway through, where some tokens may be gone.
      toast.error("Something went wrong", {
        description:
          "We could not confirm whether this finished. Reload the page to see the current state before trying again.",
      });
    } finally {
      setIsRevoking(false);
      setRevokeTarget(null);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Admin</h1>

      <DomainSection />

      <CertificateSection />

      <StorageSection />

      <div className="rounded-lg border border-error/30 bg-error/10">
        <div className="border-b border-error/30 px-5 py-4">
          <h2 className="text-base font-semibold text-error">
            Destructive Actions
          </h2>
          <p className="mt-1 text-sm text-error/70">
            These actions cannot be undone, proceed with caution.
          </p>
        </div>

        <div className="divide-y divide-red-500/20">
          {/* Revoke GitHub tokens */}
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <p className="text-sm text-error/80">
              Delete the GitHub connection Paco holds for every person here, so
              they all have to connect again.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 border-error/30 text-error hover:bg-error/10 hover:text-error"
              onClick={() => setRevokeTarget("github")}
            >
              Disconnect everyone
            </Button>
          </div>
        </div>
      </div>

      {/* Confirmation dialog */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-error" />
              Disconnect GitHub for everyone?
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <span className="block">
                Paco forgets the GitHub access every person here has set up.
                Their work is untouched, but anything that needs GitHub — saving
                a branch, opening a pull request, reading a repository — stops
                working for all of them until each one connects again with a new
                token. Paco cannot put them back for them.
              </span>
              {/*
                This dialog used to promise a forced sign-out and redirect that
                the handler never performed. A confirmation that describes
                consequences it does not have is worse than none: it is the
                sentence people read to decide, and being wrong once teaches
                them to skim the next one.
              */}
              <span className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                Nobody is signed out, and this does not cancel the tokens at
                GitHub — they stay valid there until each person deletes their
                own.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isRevoking}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={isRevoking}
            >
              {isRevoking ? <Loader2 className="size-4 animate-spin" /> : null}
              {isRevoking ? "Disconnecting…" : "Disconnect everyone"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminPage() {
  return <AdminPageContent />;
}
