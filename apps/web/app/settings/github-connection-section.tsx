"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import type { GithubConnectionResponse } from "@/app/api/github/connection/route";
import { GithubIcon } from "@/components/github-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { GH_CLI_MISSING } from "@/lib/error-copy";
import { sanitizeInternalRedirect } from "@/lib/redirect-safety";
import { fetcher } from "@/lib/swr";
import { toast } from "@/lib/toast";
import { GitHubDisconnectDialog } from "./github-disconnect-dialog";

const ENDPOINT = "/api/github/connection";

/**
 * The token this asks for, and why it asks rather than redirecting.
 *
 * Paco drives GitHub through the `gh` CLI, which authenticates with a token —
 * there is no app to install and no OAuth round trip to send the user on. The
 * cost is that the token has to be created on GitHub and pasted here once.
 */
const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,workflow,read:org&description=Paco";

/**
 * The one problem no token can fix.
 *
 * Shown in both branches of this section, because a stored token and an absent
 * CLI look like a healthy connection right up to the point where every action
 * fails. Until GET reported this, it could only appear after a token had been
 * pasted and rejected — the answer arriving after the work.
 */
function GhCliMissingNotice() {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-error text-sm">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{GH_CLI_MISSING}</span>
    </p>
  );
}

function scopeSummary(scopes: string[]): string {
  if (scopes.length === 0) {
    // Fine-grained tokens do not report their scopes at all.
    return "Permissions are set on GitHub for this token.";
  }
  return scopes.join(", ");
}

export function GitHubConnectionSection() {
  const { data, isLoading, mutate } = useSWR<GithubConnectionResponse>(
    ENDPOINT,
    fetcher,
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const router = useRouter();

  if (isLoading) {
    return <GitHubConnectionSectionSkeleton />;
  }

  const connect = async () => {
    setBusy(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: unknown }).error)
            : "Could not verify that token";
        toast.error(message);
        return;
      }

      // Cleared on success only, so a rejected token stays in the field to be
      // corrected rather than retyped.
      setToken("");
      await mutate(body as GithubConnectionResponse, { revalidate: false });
      toast.success(
        `Connected as ${(body as GithubConnectionResponse).login ?? "GitHub"}`,
      );

      /*
       * Return whoever was sent here to reconnect mid-task.
       *
       * `buildGitHubReconnectUrl` carries a `next`, because the thing that
       * needed GitHub — creating a repository, provisioning a workspace —
       * is somewhere else entirely, and landing them in Settings with no way
       * back is how a two-click fix turns into a hunt.
       *
       * Read off `window.location` rather than `useSearchParams`, which
       * would put this whole section behind a Suspense boundary for a value
       * only this handler ever reads. Sanitized, since it arrives in a URL:
       * `sanitizeInternalRedirect` rejects anything off-origin.
       */
      const requestedNext = new URLSearchParams(window.location.search).get(
        "next",
      );
      if (requestedNext) {
        const destination = sanitizeInternalRedirect(
          requestedNext,
          "/settings/connections",
        );
        if (destination !== "/settings/connections") {
          router.push(destination);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await fetch(ENDPOINT, { method: "DELETE" });
      await mutate();
      toast.success("GitHub disconnected");
    } finally {
      setBusy(false);
      setConfirmingDisconnect(false);
    }
  };

  if (data?.connected) {
    /*
     * A stored token that cannot be decrypted is worse than no token: every
     * GitHub action fails and this page said the account was connected, so
     * there was nothing to act on. It is reported as its own state, with the
     * cause named, because the fix is not obvious from the symptom.
     */
    const unreadable = data.tokenUnreadable === true;

    return (
      <section className="rounded-lg border border-base-300 p-4">
        <div className="flex items-start gap-3">
          {unreadable ? (
            <AlertTriangle className="mt-0.5 size-5 text-warning" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-5 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">
              {unreadable
                ? `Paco can no longer read the token for ${data.login}`
                : `GitHub connected as ${data.login}`}
            </h2>
            {unreadable ? (
              <p className="mt-1 text-sm text-base-content/60">
                Saved tokens are encrypted with this instance&rsquo;s{" "}
                <code className="font-mono text-xs">APP_SECRET</code>. That
                value has changed since this one was saved, so it cannot be
                unlocked any more and every GitHub action will fail. Disconnect
                and paste a new token to fix it &mdash; or restore the old{" "}
                <code className="font-mono text-xs">APP_SECRET</code> if you
                still have it.
              </p>
            ) : (
              <p className="mt-1 text-sm text-base-content/60">
                Paco uses this to save your work to GitHub, make new
                repositories, and open pull requests &mdash; all as you.{" "}
                {scopeSummary(data.scopes)}
              </p>
            )}

            {data.cliMissing ? <GhCliMissingNotice /> : null}

            {data.missingScopes.length > 0 && !unreadable ? (
              <p className="mt-2 flex items-start gap-1.5 text-sm text-warning">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                <span>
                  Missing {data.missingScopes.join(", ")}. Some actions will
                  fail until you replace this with a token that has them.
                </span>
              </p>
            ) : null}

            <Button
              className="mt-3"
              disabled={busy}
              onClick={() => setConfirmingDisconnect(true)}
              size="sm"
              variant="outline"
            >
              Disconnect
            </Button>
          </div>
        </div>

        <GitHubDisconnectDialog
          busy={busy}
          login={data.login}
          onConfirm={() => void disconnect()}
          onOpenChange={(open) => {
            if (!open) setConfirmingDisconnect(false);
          }}
          open={confirmingDisconnect}
        />
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-base-300 p-4">
      <div className="flex items-start gap-3">
        <GithubIcon className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Connect GitHub</h2>
          <p className="mt-1 text-sm text-base-content/60">
            Connect GitHub and Paco can save your work there for you. GitHub
            gives you a long password called an access token; create one with{" "}
            <code>repo</code> access and paste it below. It is kept on this
            machine and used only for your account.{" "}
            <a
              className="link"
              href={TOKEN_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              Create one on GitHub
            </a>
            .
          </p>

          {data?.cliMissing ? <GhCliMissingNotice /> : null}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <Label className="sr-only" htmlFor="github-token">
                GitHub personal access token
              </Label>
              <Input
                autoComplete="off"
                id="github-token"
                onChange={(event) => setToken(event.target.value)}
                placeholder="ghp_…"
                spellCheck={false}
                type="password"
                value={token}
              />
            </div>
            <Button
              disabled={busy || token.trim().length === 0}
              onClick={() => void connect()}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : null}
              Connect
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export function GitHubConnectionSectionSkeleton() {
  return (
    <section className="rounded-lg border border-base-300 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <Skeleton className="mt-3 h-9 w-full max-w-sm" />
    </section>
  );
}
