"use client";

import { Loader2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { SignInButton } from "./sign-in-button";

/**
 * Gate for anything that needs a signed-in user.
 *
 * The fallbacks are what someone sees when a page they bookmarked turns out to
 * need an account, so they say what is happening and what to do about it —
 * "Loading..." and "Please sign in to continue" said neither.
 */
export function AuthGuard({
  children,
  loadingFallback,
  unauthenticatedFallback,
}: {
  children: React.ReactNode;
  loadingFallback?: React.ReactNode;
  unauthenticatedFallback?: React.ReactNode;
}) {
  const { loading, isAuthenticated } = useSession();

  if (loading) {
    return (
      <>
        {loadingFallback ?? (
          <output
            aria-live="polite"
            className="flex flex-col items-center gap-2 p-8 text-center"
          >
            <Loader2
              aria-hidden="true"
              className="size-5 animate-spin text-base-content/40"
            />
            <span className="text-sm text-base-content/60">
              Checking that you are signed in…
            </span>
          </output>
        )}
      </>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        {unauthenticatedFallback ?? (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="space-y-1">
              <p className="font-medium">You need to be signed in for this</p>
              <p className="max-w-sm text-sm text-base-content/60">
                Enter your email and we will send you a link that signs you in
                &mdash; there is no password to remember.
              </p>
            </div>
            <SignInButton />
          </div>
        )}
      </>
    );
  }

  return <>{children}</>;
}
