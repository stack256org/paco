"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * What Profile shows when there is nothing to chart.
 *
 * Both cases used to render as nothing at all, or as one dead sentence: a
 * brand-new account saw an empty page and could not tell whether it was broken,
 * and a failed request offered no way to try again short of a browser reload.
 */

export function UsageLoadError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-200/30 px-5 py-6 text-center">
      <p className="text-sm font-medium">We could not load your activity.</p>
      <p className="mt-1 text-sm text-base-content/60">
        Nothing is lost — this page only reads your history. Try again in a
        moment.
      </p>
      <Button className="mt-4" onClick={onRetry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
}

export function NoUsageYet({
  filtered = false,
}: {
  readonly filtered?: boolean;
}) {
  // A date filter that matched nothing is a different situation from a new
  // account, and telling someone to start their first session when they have
  // simply picked a quiet week reads as a bug.
  if (filtered) {
    return (
      <div className="rounded-lg border border-dashed border-base-300 px-5 py-8 text-center">
        <p className="text-sm font-medium">Nothing happened on these dates</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
          Clear the date filter above to see everything you have worked on.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-dashed border-base-300 px-5 py-8 text-center">
      <p className="text-sm font-medium">Nothing to show yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-base-content/60">
        Once you have asked Paco to build something, this page keeps a record of
        what you worked on, how much it did, and roughly what it cost.
      </p>
      <Button asChild className="mt-4" size="sm">
        <Link href="/sessions">Start your first session</Link>
      </Button>
    </div>
  );
}
