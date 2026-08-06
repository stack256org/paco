"use client";

import type { ReactNode } from "react";
import type { FileOpenIssue } from "./use-file-editor";

/**
 * The screens that are not a file: loading, nothing here yet, and the handful
 * of reasons a file cannot be opened.
 *
 * Every line says what happened and what to do about it. Nothing here names a
 * status code, a byte count, or an internal term — the person reading it wants
 * to edit a document.
 */

export function PanelMessage({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="font-medium text-sm">{title}</p>
      {detail ? (
        <p className="max-w-xs text-base-content/60 text-xs">{detail}</p>
      ) : null}
      {children}
    </div>
  );
}

export function PanelLoading({ label }: { label: string }) {
  return (
    <div
      aria-live="polite"
      className="flex h-full flex-col items-center justify-center gap-2 p-6"
    >
      <span aria-hidden="true" className="loading loading-spinner loading-sm" />
      <p className="text-base-content/60 text-xs">{label}</p>
    </div>
  );
}

export function RetryButton({
  label = "Try again",
  onRetry,
}: {
  label?: string;
  onRetry: () => void;
}) {
  return (
    <button className="btn btn-sm" onClick={onRetry} type="button">
      {label}
    </button>
  );
}

/** Whether trying the same request again could plausibly work. */
export function isRetryable(issue: FileOpenIssue): boolean {
  return issue !== "too-large" && issue !== "not-text";
}

const ISSUE_TITLES: Record<FileOpenIssue, string> = {
  "too-large": "This file is too big to open here",
  "not-text": "This file can't be shown",
  missing: "This file isn't here any more",
  unavailable: "Your workspace isn't available right now",
  unknown: "We couldn't open this file",
};

/**
 * Extra guidance for the two problems a retry will never fix.
 *
 * There is no way to download a file the server refuses to read, so saying so
 * plainly — and pointing at the one thing that does work — beats offering a
 * button that cannot deliver.
 */
const ISSUE_ADVICE: Partial<Record<FileOpenIssue, string>> = {
  "too-large":
    "It's still in your project and still works — it's just too long to show or edit in this panel. Ask the assistant in the chat to make the change for you.",
  "not-text":
    "Things like images, PDFs and fonts aren't made of text, so there's nothing to read or edit here.",
};

export function FileOpenProblem({
  issue,
  message,
  onRetry,
}: {
  issue: FileOpenIssue;
  /** The explanation the server sent, already written for people. */
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <PanelMessage
      detail={ISSUE_ADVICE[issue] ?? message ?? undefined}
      title={ISSUE_TITLES[issue]}
    >
      {isRetryable(issue) ? <RetryButton onRetry={onRetry} /> : null}
    </PanelMessage>
  );
}
