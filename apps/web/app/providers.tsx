"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef } from "react";
import { Toaster } from "@/components/ui/toaster";
import { SWRConfig } from "swr";
import { authClient } from "@/lib/auth/client";
import { FetchError } from "@/lib/swr";

/**
 * Global providers for the app. Wraps children in SWRConfig with a
 * global error handler that detects 401 responses and signs the user out.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const signingOut = useRef(false);

  const handleError = useCallback(
    (error: Error) => {
      /*
       * The status is the signal, not the sentence.
       *
       * This used to also require `error.message === "Not authenticated"`,
       * which quietly made a user-facing string load-bearing: rewording that
       * message — something any copy pass would do — would have switched the
       * automatic sign-out off with nothing failing to show for it. A 401 from
       * our own API already means exactly one thing.
       */
      const isSessionAuthError =
        error instanceof FetchError && error.status === 401;

      if (isSessionAuthError && !signingOut.current) {
        signingOut.current = true;
        authClient
          .signOut()
          .catch(() => {
            // if signout fails, navigate anyway so the user isn't stuck
          })
          .finally(() => {
            signingOut.current = false;
            router.replace("/");
            router.refresh();
          });
      }
    },
    [router],
  );

  return (
    <>
      <SWRConfig value={{ onError: handleError }}>{children}</SWRConfig>
      <Toaster />
    </>
  );
}
