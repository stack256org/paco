"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * What a user sees when a page throws.
 *
 * Without this file Next falls back to its own screen, whose text is
 * "Application error: a client-side exception has occurred" — the rawest
 * string in the product, shown at the moment someone is least able to act on
 * it. Only the chat route had a boundary, so every other page fell through.
 *
 * The digest is the one technical detail worth showing: it is how a self-hoster
 * finds the matching entry in their own server logs. Everything else stays in
 * the console.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-base-100 px-6 text-center">
      <h1 className="font-semibold text-lg">This page didn&rsquo;t load</h1>
      <p className="max-w-md text-base-content/70 text-sm">
        Something went wrong on our side. Your work is saved — trying again
        usually fixes it.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button onClick={reset} size="sm">
          Try again
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/sessions">Go to my sessions</Link>
        </Button>
      </div>

      {error.digest ? (
        <p className="text-base-content/50 text-xs">
          If you need to report this, quote{" "}
          <code className="font-mono">{error.digest}</code> — it matches an
          entry in the server log.
        </p>
      ) : null}
    </main>
  );
}
