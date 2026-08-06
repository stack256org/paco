"use client";

import {
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  X,
} from "lucide-react";
import type { WebAgentCommitDataPart, WebAgentPrDataPart } from "@/app/types";
import { cn } from "@/lib/utils";

/**
 * The inline rule the transcript shows when the agent commits or opens a PR.
 *
 * Rendered as a divider rather than a message: a commit is something that
 * happened to the workspace, not something the agent said, and giving it the
 * shape of a message makes the transcript read as if it spoke twice.
 */
export function GitDataPartCard({
  part,
}: {
  part: WebAgentCommitDataPart | WebAgentPrDataPart;
}) {
  const isCommit = part.type === "data-commit";
  const { status } = part.data;
  const isPending = status === "pending";
  const isSuccess = status === "success";
  const isError = status === "error";

  const url = part.data.url;

  // Commit-specific data
  const shortSha =
    isCommit && part.data.commitSha
      ? part.data.commitSha.slice(0, 7)
      : undefined;
  const commitMessage = isCommit ? part.data.commitMessage : undefined;

  // PR-specific data
  const prNumber = !isCommit ? part.data.prNumber : undefined;

  // Determine primary label
  let label: string;
  if (isCommit) {
    if (isPending) label = "Creating commit…";
    else if (isSuccess) {
      if (part.data.committed && part.data.pushed) {
        label = "Committed & pushed";
      } else if (part.data.committed) {
        label = "Committed";
      } else if (part.data.pushed) {
        label = "Pushed commits";
      } else {
        label = "Commit complete";
      }
    } else if (isError) label = part.data.error ?? "Commit failed";
    else label = "No changes to commit";
  } else {
    if (isPending) label = "Creating pull request…";
    else if (isSuccess) {
      if (part.data.requiresManualCreation) {
        label = "Ready to create on GitHub";
      } else if (part.data.syncedExisting && prNumber) {
        label = `Synced to existing PR #${prNumber}`;
      } else if (prNumber) {
        label = `Opened PR #${prNumber}`;
      } else {
        label = "Pull request ready";
      }
    } else if (isError) label = part.data.error ?? "PR failed";
    else label = part.data.skipReason ?? "PR skipped";
  }

  // Build the detail fragment shown after the dot separator
  const detail = isCommit ? (shortSha ?? commitMessage) : undefined;

  // The icon shown inline in the separator
  const IconEl = isPending ? (
    <Loader2 className="h-3 w-3 animate-spin text-base-content/50" />
  ) : isError ? (
    <X className="h-3 w-3 text-error/70" />
  ) : isCommit ? (
    <GitCommitHorizontal className="h-3 w-3 text-base-content/50" />
  ) : (
    <GitPullRequest className="h-3 w-3 text-base-content/50" />
  );

  // For commits with both a SHA and a message, show the message beneath
  const subtitle =
    isCommit && shortSha && commitMessage ? commitMessage : undefined;

  const textColor = isError ? "text-error/70" : "text-base-content/70";

  const Wrapper = url && !isPending ? "a" : "div";
  const wrapperProps =
    url && !isPending
      ? ({
          href: url,
          target: "_blank",
          rel: "noreferrer",
        } as const)
      : {};

  return (
    <div className="flex items-center gap-3 py-1">
      {/* Left rule */}
      <div className="h-px flex-1 bg-border/60" />

      {/* Center label */}
      <Wrapper
        {...wrapperProps}
        className={cn(
          "group/sep flex max-w-[80%] items-center gap-1.5",
          url && !isPending && "cursor-pointer",
        )}
      >
        {IconEl}
        <span
          className={cn(
            "truncate text-xs font-medium",
            textColor,
            url &&
              !isPending &&
              "group-hover/sep:text-base-content transition-colors",
          )}
        >
          {label}
        </span>
        {detail && (
          <>
            <span className="text-base-content/30">·</span>
            <span
              className={cn(
                "truncate font-mono text-[11px]",
                textColor,
                url &&
                  !isPending &&
                  "group-hover/sep:text-base-content transition-colors",
              )}
            >
              {detail}
            </span>
          </>
        )}
        {url && !isPending && (
          <ExternalLink
            className={cn(
              "h-3 w-3 shrink-0 text-base-content/0 transition-colors",
              "group-hover/sep:text-base-content/60",
            )}
          />
        )}
      </Wrapper>

      {/* Right rule */}
      <div className="h-px flex-1 bg-border/60" />

      {/* Subtitle (commit message when SHA is shown as detail) */}
      {subtitle && <p className="sr-only">{subtitle}</p>}
    </div>
  );
}
