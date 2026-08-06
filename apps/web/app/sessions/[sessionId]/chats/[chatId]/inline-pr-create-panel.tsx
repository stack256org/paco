"use client";

import { GitHubConnectionWarning } from "./github-connection-warning";
import { useChatId } from "./hooks/use-chat-id";
import type { WebAgentUIMessage } from "@/app/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionGitStatus } from "@/hooks/use-session-git-status";
import type { Session } from "@/lib/db/schema";
import { createBranch } from "@/lib/git/actions/branch";
import { generatePrContent, openPullRequest } from "@/lib/github/actions/pr";
import type { GithubConnectionState } from "@/lib/github/connection-state";
import {
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";

export function InlinePrCreatePanel({
  session,
  hasSandbox,
  gitStatus,
  refreshGitStatus,
  hasUncommittedGitChanges,
  onPrDetected,
  onGitMessage,
  isAgentWorking,
  baseBranch,
  githubState,
}: {
  session: Session;
  hasSandbox: boolean;
  gitStatus: SessionGitStatus | null;
  refreshGitStatus: () => Promise<SessionGitStatus | undefined>;
  hasUncommittedGitChanges: boolean;
  onPrDetected?: (info: {
    prNumber: number;
    prStatus: "open" | "merged" | "closed";
  }) => void;
  onGitMessage?: (message: WebAgentUIMessage) => Promise<void> | void;
  isAgentWorking: boolean;
  baseBranch: string;
  githubState: GithubConnectionState;
}) {
  const chatId = useChatId();
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [prSuccess, setPrSuccess] = useState<{
    prUrl: string;
    requiresManualCreation?: boolean;
    isDraft?: boolean;
    autoMergeEnabled?: boolean;
    autoMergeError?: string;
  } | null>(null);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [resolvedBranch, setResolvedBranch] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [enableAutoMerge, setEnableAutoMerge] = useState(false);

  const branchFromStatus =
    resolvedBranch ??
    (gitStatus?.branch && gitStatus.branch !== "HEAD"
      ? gitStatus.branch
      : null);
  const currentBranch = branchFromStatus ?? session.branch ?? baseBranch;
  const displayBranch = currentBranch === "HEAD" ? baseBranch : currentBranch;
  const isDetachedHead = gitStatus?.isDetachedHead ?? false;
  const needsNewBranch = displayBranch === baseBranch || isDetachedHead;

  const handleCreateBranch = async () => {
    if (!hasSandbox) return;
    setIsCreatingBranch(true);
    setPrError(null);
    try {
      const result = await createBranch({
        sessionId: session.id,
        // The branch has to be created in this chat's worktree; without the id
        // it was created in the session repository, which holds none of the
        // work the pull request is meant to open on.
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
      setPrError(
        err instanceof Error ? err.message : "Failed to create branch",
      );
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handleExpand = () => {
    setIsExpanded(true);
  };

  const handleGenerateContent = async () => {
    setIsGenerating(true);
    setPrError(null);
    try {
      const generated = await generatePrContent({
        sessionId: session.id,
        chatId,
        sessionTitle: session.title,
        baseBranch,
      });
      if (generated.error) {
        throw new Error(generated.error);
      }
      setPrTitle(generated.title ?? session.title);
      setPrBody(generated.body ?? "");
      if (generated.branchName && generated.branchName !== "HEAD") {
        setResolvedBranch(generated.branchName);
      }
    } catch (err) {
      setPrError(
        err instanceof Error
          ? err.message
          : "Failed to generate pull request content",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCreatePr = async (isDraft = false) => {
    setIsCreatingPr(true);
    setPrError(null);

    const gitMessageId = crypto.randomUUID();
    const prPartId = `${gitMessageId}:pr`;

    try {
      let finalTitle = prTitle.trim();
      let finalBody = prBody.trim();

      // Auto-generate if title is empty
      if (!finalTitle) {
        setIsGenerating(true);
        try {
          const generated = await generatePrContent({
            sessionId: session.id,
            chatId,
            sessionTitle: session.title,
            baseBranch,
          });
          if (generated.error) {
            throw new Error(generated.error);
          }
          finalTitle = generated.title ?? session.title;
          finalBody = finalBody || (generated.body ?? "");
          if (generated.branchName && generated.branchName !== "HEAD") {
            setResolvedBranch(generated.branchName);
          }
        } finally {
          setIsGenerating(false);
        }
      }

      // Emit pending data-pr part
      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-pr",
            id: prPartId,
            data: { status: "pending" },
          },
        ],
      });

      const data = await openPullRequest({
        sessionId: session.id,
        chatId,
        title: finalTitle,
        body: finalBody,
        baseBranch,
        isDraft,
      });

      if (data.error) {
        throw new Error(data.error);
      }

      setPrSuccess({
        prUrl: data.prUrl ?? "",
        // The App path could fail partway and hand the user a compare URL to
        // finish by hand; `gh pr create` either opens the pull request or
        // explains why it could not.
        requiresManualCreation: false,
        isDraft,
        // Auto-merge needs a repository setting Paco cannot read without admin
        // access, so it is no longer offered here — GitHub's own button does
        // it in one click.
        autoMergeEnabled: false,
      });

      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-pr",
            id: prPartId,
            data: {
              status: "success",
              created: true,
              prNumber:
                typeof data.prNumber === "number" ? data.prNumber : undefined,
              url: typeof data.prUrl === "string" ? data.prUrl : undefined,
            },
          },
        ],
      });

      if (typeof data.prNumber === "number") {
        onPrDetected?.({
          prNumber: data.prNumber,
          prStatus:
            data.prStatus === "merged" || data.prStatus === "closed"
              ? data.prStatus
              : "open",
        });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to create PR";
      await onGitMessage?.({
        id: gitMessageId,
        role: "assistant",
        metadata: {},
        parts: [
          {
            type: "data-pr",
            id: prPartId,
            data: {
              status: "error",
              error: errorMessage,
            },
          },
        ],
      });
      setPrError(errorMessage);
    } finally {
      setIsCreatingPr(false);
    }
  };

  // Success state
  if (prSuccess) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 p-2 text-xs text-success">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span>
            {prSuccess.requiresManualCreation
              ? "Compare page opened"
              : prSuccess.autoMergeEnabled
                ? "PR created — auto-merge enabled!"
                : prSuccess.isDraft
                  ? "Draft pull request created!"
                  : "Pull request created!"}
          </span>
        </div>
        {prSuccess.autoMergeError && (
          <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            {prSuccess.autoMergeError}
          </div>
        )}
        {/* oxlint-disable-next-line nextjs/no-html-link-for-pages */}
        <a
          href={prSuccess.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-info hover:underline"
        >
          {prSuccess.requiresManualCreation
            ? "Open compare page"
            : "View on GitHub"}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    );
  }

  // Needs branch creation
  if (needsNewBranch) {
    const branchDisabledTooltip = isAgentWorking
      ? "Wait for the agent to finish"
      : !hasSandbox
        ? "Waiting for sandbox to start"
        : null;

    const branchContent = (
      <div className="space-y-2">
        <GitHubConnectionWarning state={githubState} />
        <div className="rounded-md border border-base-300 bg-base-200/40 p-2 text-xs text-base-content/60">
          {isDetachedHead
            ? "Detached HEAD — create a branch first."
            : "On base branch — create a new branch first."}
        </div>
        <Button
          size="sm"
          className="w-full text-xs"
          onClick={() => void handleCreateBranch()}
          disabled={isAgentWorking || isCreatingBranch || !hasSandbox}
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
        {prError && (
          <div className="rounded-md bg-error/10 p-2 text-xs text-error">
            {prError}
          </div>
        )}
      </div>
    );

    if (branchDisabledTooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div>{branchContent}</div>
          </TooltipTrigger>
          <TooltipContent side="bottom">{branchDisabledTooltip}</TooltipContent>
        </Tooltip>
      );
    }

    return branchContent;
  }

  // Uncommitted changes warning
  if (hasUncommittedGitChanges) {
    return (
      <div className="px-2 py-3 text-center text-xs text-base-content/60">
        Commit your changes before creating a pull request.
      </div>
    );
  }

  const prDisabled = isAgentWorking || isCreatingPr || !hasSandbox;

  const prDisabledTooltip = isAgentWorking
    ? "Wait for the agent to finish"
    : !hasSandbox
      ? "Waiting for sandbox to start"
      : null;

  // PR creation form
  const prForm = (
    <div className="space-y-2">
      <GitHubConnectionWarning state={githubState} />
      {isExpanded && (
        <>
          <div className="relative">
            <Input
              aria-label="Pull request title"
              placeholder="PR title"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              disabled={isAgentWorking || isCreatingPr}
              className="h-8 pr-7 text-xs"
            />
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-base-content/40 transition-colors hover:bg-base-200/50 hover:text-base-content/60 disabled:pointer-events-none disabled:opacity-50"
              onClick={() => void handleGenerateContent()}
              disabled={isGenerating}
            >
              {isGenerating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <WandSparkles className="h-3 w-3" />
              )}
            </button>
          </div>
          <Textarea
            aria-label="Pull request description"
            placeholder="Description"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            disabled={isAgentWorking || isCreatingPr}
            rows={3}
            className="max-h-40 text-xs"
          />
          <div className="flex items-center justify-between rounded-md border border-base-300 bg-base-200/30 p-2">
            <div className="space-y-0.5 pr-3">
              <p className="text-xs font-medium">Auto-merge</p>
              <p className="text-[10px] text-base-content/60">
                Merge automatically once checks pass.
              </p>
            </div>
            <Switch
              checked={enableAutoMerge}
              onCheckedChange={setEnableAutoMerge}
              disabled={isAgentWorking || isCreatingPr}
            />
          </div>
        </>
      )}
      <div className="flex w-full">
        <Button
          size="sm"
          className="min-w-0 flex-1 rounded-r-none text-xs"
          onClick={() => void handleCreatePr()}
          disabled={prDisabled}
        >
          {isCreatingPr ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              {isGenerating ? "Generating..." : "Creating..."}
            </>
          ) : (
            <>
              {prTitle.trim() ? (
                <GitPullRequest className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              Create Pull Request
            </>
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="icon"
              className="h-8 w-8 rounded-l-none border-l border-l-primary-foreground/25"
              disabled={prDisabled}
              aria-label="PR options"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            <DropdownMenuItem
              onSelect={() => void handleCreatePr(true)}
              className="gap-2 text-xs"
            >
              Create Draft PR
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!isExpanded && (
        <button
          type="button"
          className="w-full text-center text-xs text-base-content/60 transition-colors hover:text-base-content/60"
          onClick={handleExpand}
        >
          Edit title & description
        </button>
      )}
      {prError && (
        <div className="rounded-md bg-error/10 p-2 text-xs text-error">
          {prError}
        </div>
      )}
    </div>
  );

  if (prDisabledTooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div>{prForm}</div>
        </TooltipTrigger>
        <TooltipContent side="bottom">{prDisabledTooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return prForm;
}
