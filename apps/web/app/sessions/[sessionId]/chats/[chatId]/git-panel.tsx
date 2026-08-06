"use client";

import {
  ExternalLink,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DiffFile } from "@/app/api/sessions/[sessionId]/diff/route";
import type { WebAgentUIMessage } from "@/app/types";
import { discardChanges } from "@/lib/git/actions/discard";
import type { MergePullRequestResult } from "@/lib/github/actions/pr";
import type { Session } from "@/lib/db/schema";
import type { CheckRun } from "@/lib/github/queries/pr";
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
import { cn } from "@/lib/utils";
import { fetchRepoBranches } from "@/lib/git/branches";
import type { SessionGitStatus } from "@/hooks/use-session-git-status";
import { useGithubConnection } from "@/hooks/use-github-connection";
import { useChatId } from "./hooks/use-chat-id";
import { useGitPanel } from "./git-panel-context";
import { isUncommittedFile } from "./git-diff-file-list";
import { InlineCommitPanel } from "./inline-commit-panel";
import { InlineMergePanel } from "./inline-merge-panel";
import { InlinePrCreatePanel } from "./inline-pr-create-panel";
import { useSessionChatWorkspaceContext } from "./session-chat-context";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type GitPanelProps = {
  session: Session;
  // Git state
  hasRepo: boolean;
  hasExistingPr: boolean;
  existingPrUrl: string | null;
  hasUncommittedGitChanges: boolean;
  canCloseAndArchive: boolean;

  // Diff data
  diffFiles: DiffFile[] | null;

  // Actions
  onCreateRepoClick: () => void;
  refreshDiff: () => Promise<void>;

  // Merge
  onMerged: (result: MergePullRequestResult) => Promise<void> | void;
  onCloseAndArchiveClick: () => void;
  onFixChecks?: (failedRuns: CheckRun[]) => Promise<void> | void;
  onFixConflicts?: (baseBranchRef: string) => Promise<void> | void;

  // For inline commit
  hasSandbox: boolean;
  gitStatus: SessionGitStatus | null;
  refreshGitStatus: () => Promise<SessionGitStatus | undefined>;
  onCommitted?: () => Promise<void> | void;
  isAgentWorking: boolean;

  // For inline PR creation
  onPrDetected?: (info: {
    prNumber: number;
    prStatus: "open" | "merged" | "closed";
  }) => void;
  onGitMessage?: (message: WebAgentUIMessage) => Promise<void> | void;
};

/**
 * The action bar under the Changes tab's diff: commit, pull request, merge.
 *
 * It used to be a whole second panel with its own Files / Changes / PR tabs,
 * opened by a git button in the header — three tabs that repeated the three
 * the workspace pane already has, and a button that rendered them into a
 * hidden node. What is left is only the things you *do* with the changes on
 * screen; looking at them is the diff's job, and browsing files is the Files
 * tab's.
 */
export function GitPanel(props: GitPanelProps) {
  const chatId = useChatId();
  const { workspaceTab, diffScope, setDiffScope } = useGitPanel();

  const {
    session,
    hasRepo,
    hasExistingPr,
    existingPrUrl,
    hasUncommittedGitChanges,
    canCloseAndArchive,
    diffFiles,
    onCreateRepoClick,
    refreshDiff,
    onMerged,
    onCloseAndArchiveClick,
    onFixChecks,
    onFixConflicts,
    hasSandbox,
    gitStatus,
    refreshGitStatus,
    onCommitted,
    onPrDetected,
    onGitMessage,
    isAgentWorking,
  } = props;
  const { refreshFiles } = useSessionChatWorkspaceContext();
  /*
   * One value, not two booleans.
   *
   * This used to derive `reconnectRequired` as `!githubConnected`, which made
   * "you have never connected an account" and "the account you connected has
   * stopped working" the same state — and the warning below tested the derived
   * one first, so everybody got the reconnect message. It also had no way to
   * express the two states that are not absences at all: a stored token Paco
   * can no longer decrypt, and a machine with no `gh` installed.
   */
  const { state: githubState } = useGithubConnection({
    enabled: hasRepo,
  });
  const [baseBranch, setBaseBranch] = useState("main");
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [isDiscardingChanges, setIsDiscardingChanges] = useState(false);

  const handleDiscardChanges = useCallback(async () => {
    setIsDiscardingChanges(true);
    setDiscardError(null);

    try {
      await discardChanges({
        sessionId: session.id,
        // Without this the action ran `git reset --hard` and `git clean -fd`
        // in the *session* repository: it deleted untracked files there,
        // discarded nothing the chat had done, and still reported success.
        chatId,
      });
    } catch (error) {
      setDiscardError(
        error instanceof Error
          ? error.message
          : "Could not discard the changes",
      );
      setIsDiscardingChanges(false);
      return;
    }

    await Promise.allSettled([
      refreshDiff(),
      refreshGitStatus(),
      refreshFiles(),
    ]);
    setDiscardDialogOpen(false);
    setIsDiscardingChanges(false);
  }, [chatId, refreshDiff, refreshFiles, refreshGitStatus, session.id]);

  /*
   * Ask GitHub for the default branch, but only once the tab is on screen.
   *
   * The panel is mounted for the whole chat now rather than only while a
   * drawer was open, and this is a real API call — doing it on every chat load
   * would spend a request nobody asked for.
   */
  useEffect(() => {
    if (workspaceTab !== "changes" || !session.repoOwner || !session.repoName) {
      return;
    }

    let cancelled = false;

    void fetchRepoBranches(session.repoOwner, session.repoName)
      .then((data) => {
        if (!cancelled) {
          setBaseBranch(data.defaultBranch);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [session.repoOwner, session.repoName, workspaceTab]);

  const hasUnstagedChanges =
    (gitStatus?.unstagedCount ?? 0) > 0 ||
    Boolean(diffFiles?.some(isUncommittedFile));
  const hasAnyDiffFiles = (diffFiles?.length ?? 0) > 0;
  const diffScopeManuallySetRef = useRef(false);

  /*
   * Open on whichever scope has something in it.
   *
   * Landing on "Not committed yet" when everything is already committed shows
   * an empty diff and reads as "my work is gone". The choice is only made on
   * the way into the tab, so it never overrides a deliberate one.
   */
  useEffect(() => {
    if (workspaceTab !== "changes") {
      diffScopeManuallySetRef.current = false;
      return;
    }

    if (!diffScopeManuallySetRef.current) {
      setDiffScope(hasUnstagedChanges ? "uncommitted" : "branch");
    }
  }, [workspaceTab, hasUnstagedChanges, setDiffScope]);

  const scopeOptions = [
    { id: "branch" as const, label: "All changes" },
    { id: "uncommitted" as const, label: "Not committed yet" },
  ];

  return (
    <div className="flex flex-col border-base-300 border-t bg-base-200/40">
      {/* What the diff above is showing, plus the state of the branch. */}
      <div className="flex flex-wrap items-center gap-2 border-base-300 border-b px-3 py-1.5">
        {hasAnyDiffFiles ? (
          <div className="tabs tabs-box tabs-xs" role="tablist">
            {scopeOptions.map((option) => {
              const isActive = diffScope === option.id;

              return (
                <button
                  aria-selected={isActive}
                  className={cn("tab", isActive && "tab-active")}
                  key={option.id}
                  onClick={() => {
                    diffScopeManuallySetRef.current = true;
                    setDiffScope(option.id);
                  }}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {hasExistingPr && existingPrUrl ? (
            /* oxlint-disable-next-line nextjs/no-html-link-for-pages */
            <a
              className="btn btn-ghost btn-xs"
              href={existingPrUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {session.prStatus === "merged" ? (
                <GitMerge aria-hidden="true" className="size-3.5" />
              ) : session.prStatus === "closed" ? (
                <GitPullRequestClosed
                  aria-hidden="true"
                  className="size-3.5 text-error"
                />
              ) : (
                <GitPullRequest aria-hidden="true" className="size-3.5" />
              )}
              Pull request #{session.prNumber}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : null}

          {hasUncommittedGitChanges ? (
            <button
              className="btn btn-ghost btn-xs"
              disabled={!hasSandbox || isDiscardingChanges || isAgentWorking}
              onClick={() => {
                setDiscardError(null);
                setDiscardDialogOpen(true);
              }}
              type="button"
            >
              {isDiscardingChanges ? (
                <span
                  aria-hidden="true"
                  className="loading loading-spinner loading-xs"
                />
              ) : (
                <Trash2 aria-hidden="true" className="size-3.5" />
              )}
              Throw away changes
            </button>
          ) : null}
        </div>
      </div>

      {/*
        The actions themselves.

        Committing is local git and needs no GitHub account: `commitChanges`
        handles a workspace with no repository explicitly, and auto-save relies
        on that. Gating the whole panel on `hasRepo` therefore hid the one
        action that did work, behind a sentence — "there is nowhere to save
        these changes" — that was not true. Only publishing needs GitHub, so
        only publishing is gated on it now.
      */}
      <div className="space-y-2 p-3">
        <InlineCommitPanel
          baseBranch={baseBranch}
          gitStatus={gitStatus}
          githubState={githubState}
          hasSandbox={hasSandbox}
          isAgentWorking={isAgentWorking}
          onCommitted={onCommitted}
          onGitMessage={onGitMessage}
          refreshGitStatus={refreshGitStatus}
          session={session}
        />

        {hasRepo ? (
          <div className="border-base-300 border-t pt-2">
            {hasExistingPr ? (
              <InlineMergePanel
                canCloseAndArchive={canCloseAndArchive}
                isAgentWorking={isAgentWorking}
                onCloseAndArchiveClick={onCloseAndArchiveClick}
                onFixChecks={onFixChecks}
                onFixConflicts={onFixConflicts}
                onMerged={onMerged}
                session={session}
              />
            ) : (
              <InlinePrCreatePanel
                baseBranch={baseBranch}
                gitStatus={gitStatus}
                githubState={githubState}
                hasSandbox={hasSandbox}
                hasUncommittedGitChanges={hasUncommittedGitChanges}
                isAgentWorking={isAgentWorking}
                onGitMessage={onGitMessage}
                onPrDetected={onPrDetected}
                refreshGitStatus={refreshGitStatus}
                session={session}
              />
            )}
          </div>
        ) : (
          <div className="space-y-2 border-base-300 border-t pt-2 text-center">
            <p className="text-base-content/60 text-xs">
              Saves stay on this computer. Connect a GitHub repository to keep a
              copy somewhere safe and to ask for a review.
            </p>
            <button
              className="btn btn-outline btn-sm"
              onClick={onCreateRepoClick}
              type="button"
            >
              <FolderGit2 aria-hidden="true" className="size-3.5" />
              Create a repository
            </button>
          </div>
        )}
      </div>

      <Dialog
        open={discardDialogOpen}
        onOpenChange={(open) => {
          if (!isDiscardingChanges) {
            setDiscardDialogOpen(open);
          }
          if (!open) {
            setDiscardError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Throw away these changes?</DialogTitle>
            <DialogDescription>
              Everything that has not been committed yet is deleted from the
              workspace, and there is no way back. Anything already committed
              stays.
            </DialogDescription>
          </DialogHeader>
          {discardError ? (
            <div className="rounded-md bg-error/10 p-2 text-error text-xs">
              {discardError}
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isDiscardingChanges}>
                Keep them
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => void handleDiscardChanges()}
              disabled={isDiscardingChanges}
            >
              {isDiscardingChanges ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Throwing away…
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Throw away
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
