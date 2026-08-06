"use client";

import {
  Check,
  GitBranch,
  GitCommit,
  Loader2,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WebAgentUIMessage } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SessionGitStatus } from "@/hooks/use-session-git-status";
import type { Session } from "@/lib/db/schema";
import { createBranch } from "@/lib/git/actions/branch";
import { commitChanges } from "@/lib/github/actions/commit";
import type { GithubConnectionState } from "@/lib/github/connection-state";
import { chatScopedUrl } from "./chat-scoped-url";
import {
  commitBlocker,
  commitBlockerMessage,
  commitOutcome,
} from "./commit-panel-state";
import { GitHubConnectionWarning } from "./github-connection-warning";
import { useChatId } from "./hooks/use-chat-id";

export function InlineCommitPanel({
  session,
  hasSandbox,
  gitStatus,
  refreshGitStatus,
  onCommitted,
  onGitMessage,
  isAgentWorking,
  baseBranch,
  githubState,
}: {
  session: Session;
  hasSandbox: boolean;
  gitStatus: SessionGitStatus | null;
  refreshGitStatus: () => Promise<SessionGitStatus | undefined>;
  onCommitted?: () => Promise<void> | void;
  onGitMessage?: (message: WebAgentUIMessage) => Promise<void> | void;
  isAgentWorking: boolean;
  baseBranch: string;
  githubState: GithubConnectionState;
}) {
  const chatId = useChatId();
  const [commitMessage, setCommitMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  /**
   * How the last save ended, when it ended well enough to keep the work.
   *
   * `saved-not-sent` used to be reported as an error, because the panel threw
   * on any `error` field — including the one that accompanies a commit that
   * was made and then could not be pushed. The commit existed; the panel said
   * it had failed, refreshed nothing, and left the button ready for a second
   * attempt at work that was already done.
   */
  const [saveResult, setSaveResult] = useState<
    { kind: "saved" } | { kind: "saved-not-sent"; reason: string } | null
  >(null);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [resolvedBranch, setResolvedBranch] = useState<string | null>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const hasUncommittedChanges = gitStatus?.hasUncommittedChanges ?? false;
  /*
   * Whether there is anywhere to push to.
   *
   * A workspace with no GitHub repository still commits — that is what saving
   * work means locally, and `commitChanges` supports it. But calling the button
   * "Commit & Push" there promised half an action that could not happen, and
   * the GitHub connection warning above it complained about an account this
   * workspace never needed.
   */
  const hasRepo = Boolean(session.repoOwner && session.repoName);

  const hasUnpushedCommits = gitStatus?.hasUnpushedCommits ?? false;
  const hasPendingGitWork = hasUncommittedChanges || hasUnpushedCommits;

  const branchFromStatus =
    resolvedBranch ??
    (gitStatus?.branch && gitStatus.branch !== "HEAD"
      ? gitStatus.branch
      : null);
  const currentBranch = branchFromStatus ?? session.branch ?? baseBranch;
  const displayBranch = currentBranch === "HEAD" ? baseBranch : currentBranch;
  const isDetachedHead = gitStatus?.isDetachedHead ?? false;

  /*
   * Whether the branch is actually known, as opposed to guessed.
   *
   * `displayBranch` falls back to the base branch when nothing else is
   * available, so before the first git status arrives it reads as "you are on
   * the base branch" — and the panel offered Create branch to someone already
   * on their chat branch, in place of the Save button they wanted. It settled
   * a second later, which made it a flicker rather than a stuck state, but it
   * was still an answer invented out of missing data.
   */
  const branchIsKnown = Boolean(branchFromStatus ?? session.branch);
  const needsNewBranch =
    branchIsKnown && (displayBranch === baseBranch || isDetachedHead);

  // Cleanup timeout
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  const handleCreateBranch = async () => {
    if (!hasSandbox) return;
    setIsCreatingBranch(true);
    setCommitError(null);
    try {
      const result = await createBranch({
        sessionId: session.id,
        // The branch has to be created in this chat's worktree; without the id
        // it was created in the session repository, where the commit that
        // follows never goes.
        chatId,
        sessionTitle: session.title,
        baseBranch,
        branchName: displayBranch,
      });
      if (result.branchName !== "HEAD") {
        setResolvedBranch(result.branchName);
      }
      await refreshGitStatus();
    } catch (err) {
      setCommitError(
        err instanceof Error ? err.message : "Failed to create branch",
      );
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handleExpandCommit = () => {
    setIsExpanded(true);
  };

  const handleGenerateMessage = async () => {
    setIsGeneratingMessage(true);
    try {
      const res = await fetch(
        // Scoped to the chat, or the route diffs the session repository — which
        // is on the default branch, so it summarised no changes at all.
        chatScopedUrl(
          `/api/sessions/${session.id}/generate-commit-message`,
          chatId,
        ),
        { method: "POST" },
      );
      const data = await res.json();
      if (data.message) {
        setCommitMessage(data.message);
      }
    } catch {
      // silently fail
    } finally {
      setIsGeneratingMessage(false);
    }
  };

  const handleCommit = async () => {
    if (!hasSandbox || !hasPendingGitWork) return;
    setIsCommitting(true);
    setCommitError(null);
    setSaveResult(null);

    const gitMessageId = crypto.randomUUID();
    const commitPartId = `${gitMessageId}:commit`;

    try {
      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-commit",
            id: commitPartId,
            data: { status: "pending" },
          },
        ],
      });

      const trimmed = commitMessage.trim();
      const lines = trimmed.split("\n");
      const commitTitle = lines[0] ?? "";
      const commitBody = lines.slice(1).join("\n").trim();

      const result = await commitChanges({
        sessionId: session.id,
        chatId,
        ...(commitTitle ? { commitTitle, commitBody } : {}),
      });

      const outcome = commitOutcome(result, { hasRepo });

      // Only a commit that never happened is a failure. Everything below this
      // line runs for a commit that was made, whether or not GitHub has it.
      if (outcome.kind === "failed") {
        throw new Error(outcome.reason);
      }

      if (result.branchName && result.branchName !== "HEAD") {
        setResolvedBranch(result.branchName);
      }

      setSaveResult(outcome);
      setCommitMessage("");

      const commitUrl =
        result.commitSha && session.repoOwner && session.repoName
          ? `https://github.com/${session.repoOwner}/${session.repoName}/commit/${result.commitSha}`
          : undefined;

      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-commit",
            id: commitPartId,
            data: {
              status: "success",
              committed: result.committed,
              pushed: result.pushed,
              commitMessage: result.commitMessage,
              commitSha: result.commitSha,
              url: commitUrl,
            },
          },
        ],
      });

      // The diff and the button state are now wrong in both cases — the work
      // has moved out of "not committed yet" either way. Skipping this after a
      // failed push is what left people looking at a stale diff.
      await refreshGitStatus().catch(() => undefined);
      await onCommitted?.();

      // A plain success fades; one that needs reading does not, because the
      // reason it could not reach GitHub is only shown here.
      if (outcome.kind === "saved") {
        successTimeoutRef.current = setTimeout(() => {
          setSaveResult(null);
        }, 3000);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to commit and push";
      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-commit",
            id: commitPartId,
            data: {
              status: "error",
              error: errorMessage,
            },
          },
        ],
      });
      setCommitError(errorMessage);
    } finally {
      setIsCommitting(false);
    }
  };

  // Needs branch creation
  if (needsNewBranch) {
    return (
      <div className="space-y-2">
        {hasRepo ? <GitHubConnectionWarning state={githubState} /> : null}
        <div className="rounded-md border border-base-300 bg-base-200/40 p-2 text-base-content/60 text-xs">
          {isDetachedHead
            ? "Detached HEAD — create a branch first."
            : "On base branch — create a new branch first."}
        </div>
        <Button
          className="w-full text-xs"
          disabled={isAgentWorking || isCreatingBranch || !hasSandbox}
          onClick={() => void handleCreateBranch()}
          size="sm"
        >
          {isCreatingBranch ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Creating branch...
            </>
          ) : (
            <>
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
              Create branch
            </>
          )}
        </Button>
        {isAgentWorking && (
          <div className="rounded-md border border-base-300 bg-base-200/40 p-2 text-base-content/60 text-xs">
            Wait for the agent to finish before creating a branch.
          </div>
        )}
        {commitError && (
          <div className="rounded-md bg-error/10 p-2 text-error text-xs">
            {commitError}
          </div>
        )}
      </div>
    );
  }

  /*
   * Why the button is off, in a sentence.
   *
   * It used to just be `disabled`, with a tooltip that covered two of the four
   * reasons — and not the two most common ones, which are "nothing has changed
   * yet" and the first second of the page's life, before any git status has
   * come back. A disabled control with no explanation reads as a broken one.
   */
  const blocker = commitBlocker({
    isAgentWorking,
    hasSandbox,
    gitStatusKnown: gitStatus !== null,
    hasPendingGitWork,
  });
  const commitDisabled = isCommitting || blocker !== null;

  return (
    <div className="space-y-2">
      {hasRepo ? <GitHubConnectionWarning state={githubState} /> : null}

      {saveResult?.kind === "saved-not-sent" ? (
        <div
          className="alert alert-soft alert-vertical alert-warning items-start gap-1 p-2 text-xs"
          role="status"
        >
          <span className="font-medium">Saved on this computer only</span>
          <span>{saveResult.reason}</span>
        </div>
      ) : null}

      {isExpanded && (
        <div className="relative">
          <Textarea
            aria-label="A short note describing what changed"
            className="resize-none pb-7 text-xs"
            disabled={isAgentWorking || isCommitting || !hasPendingGitWork}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message"
            rows={2}
            value={commitMessage}
          />
          <button
            aria-label="Write the message for me"
            className="absolute bottom-1.5 left-1.5 rounded p-1 text-base-content/40 transition-colors hover:bg-base-200/50 hover:text-base-content/60 disabled:pointer-events-none disabled:opacity-50"
            disabled={isGeneratingMessage || !hasPendingGitWork}
            onClick={() => void handleGenerateMessage()}
            type="button"
          >
            {isGeneratingMessage ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <WandSparkles className="h-3 w-3" />
            )}
          </button>
        </div>
      )}

      {saveResult?.kind === "saved" ? (
        <div
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-success/30 bg-success/10 font-medium text-success text-xs"
          role="status"
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          {hasRepo ? "Committed" : "Saved"}
        </div>
      ) : (
        <>
          <Button
            className="w-full text-xs"
            disabled={commitDisabled}
            onClick={() => void handleCommit()}
            size="sm"
          >
            {isCommitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {hasRepo ? "Committing…" : "Saving…"}
              </>
            ) : (
              <>
                {commitMessage.trim() ? (
                  <GitCommit className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                )}
                {hasRepo ? "Commit & Push" : "Save these changes"}
              </>
            )}
          </Button>

          {/*
            Shown, not tucked into a tooltip: a touch device has no hover, and
            this is the only thing on screen that explains the dead button.
          */}
          {blocker && !isCommitting ? (
            <p className="text-center text-base-content/60 text-xs">
              {commitBlockerMessage(blocker)}
            </p>
          ) : null}

          {!isExpanded && (
            <button
              className="w-full text-center text-base-content/60 text-xs transition-colors hover:text-base-content/60 disabled:opacity-50"
              disabled={!hasPendingGitWork}
              onClick={handleExpandCommit}
              type="button"
            >
              Edit message
            </button>
          )}
        </>
      )}

      {commitError && (
        <div className="rounded-md bg-error/10 p-2 text-error text-xs">
          {commitError}
        </div>
      )}
    </div>
  );
}
