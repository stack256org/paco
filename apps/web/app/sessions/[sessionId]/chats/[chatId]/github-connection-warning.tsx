"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import {
  githubConnectionAdvice,
  type GithubConnectionState,
} from "@/lib/github/connection-state";
import { cn } from "@/lib/utils";

/**
 * Full class names, looked up rather than built, because a class assembled
 * from a variable is a class Tailwind never sees and never generates.
 */
const TONE_CLASS = {
  warning: "alert-warning",
  error: "alert-error",
} as const;

/**
 * What is wrong with this user's GitHub connection, if anything.
 *
 * One state in, one message out. It used to take two booleans and test the
 * derived one first, so a user who had never connected GitHub was told their
 * connection needed refreshing — and the branch written for them could not be
 * reached. See `lib/github/connection-state.ts` for the states themselves.
 */
export function GitHubConnectionWarning({
  state,
}: {
  state: GithubConnectionState;
}) {
  const advice = githubConnectionAdvice(state);

  if (!advice) {
    return null;
  }

  return (
    <div
      className={cn(
        "alert alert-soft alert-vertical items-start gap-2 p-2 text-xs",
        TONE_CLASS[advice.tone],
      )}
      role="alert"
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* Paired with the text, never the only signal that this is a problem. */}
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0"
        />
        <span>{advice.message}</span>
      </div>
      {advice.action ? (
        <Link className="btn btn-xs" href={advice.action.href}>
          {advice.action.label}
        </Link>
      ) : null}
    </div>
  );
}
