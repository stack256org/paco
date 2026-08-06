"use client";

import { useChatId } from "./hooks/use-chat-id";
import { CheckRunsList } from "@/components/merge-check-runs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import { forceMergeConfirm } from "./force-merge-confirm-copy";
import type { Session } from "@/lib/db/schema";
import { mergePr, type MergePullRequestResult } from "@/lib/github/actions/pr";
import {
  canForceMerge,
  hasBlocker,
  nonBypassableBlockers,
} from "@/lib/github/merge-blockers";
import {
  getMergeReadiness,
  type CheckRun,
  type MergeMethod,
  type MergeReadinessResponse,
} from "@/lib/github/queries/pr";
import {
  MERGE_READINESS_POLL_INTERVAL_MS,
  shouldIncrementMergeReadinessTransientPollCount,
  shouldPollMergeReadiness,
} from "@/lib/merge-readiness-polling";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitCommit,
  GitMerge,
  GitPullRequestClosed,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const mergeMethodLabels: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

const mergeMethodButtonLabels: Record<MergeMethod, string> = {
  squash: "Squash & Archive",
  merge: "Merge & Archive",
  rebase: "Rebase & Archive",
};

const mergeMethodDescriptions: Record<MergeMethod, string> = {
  squash: "Combine all commits into one commit in the base branch.",
  merge: "All commits will be added to the base branch via a merge commit.",
  rebase: "All commits will be rebased and added to the base branch.",
};

export function InlineMergePanel({
  session,
  onMerged,
  onCloseAndArchiveClick,
  canCloseAndArchive,
  onFixChecks,
  onFixConflicts,
  isAgentWorking,
}: {
  session: Session;
  onMerged: (result: MergePullRequestResult) => Promise<void> | void;
  onCloseAndArchiveClick: () => void;
  canCloseAndArchive: boolean;
  onFixChecks?: (failedRuns: CheckRun[]) => Promise<void> | void;
  onFixConflicts?: (baseBranchRef: string) => Promise<void> | void;
  isAgentWorking: boolean;
}) {
  const chatId = useChatId();
  const [readiness, setReadiness] = useState<MergeReadinessResponse | null>(
    null,
  );
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [isLoadingReadiness, setIsLoadingReadiness] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transientPollCount, setTransientPollCount] = useState(0);

  const readinessRequestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const { confirm: confirmMerge, dialog: mergeConfirmDialog } =
    useDestructiveConfirm();

  const loadReadiness = useCallback(async () => {
    const requestId = readinessRequestIdRef.current + 1;
    readinessRequestIdRef.current = requestId;

    setIsLoadingReadiness(true);
    setError(null);

    try {
      const readinessPayload = await getMergeReadiness({
        sessionId: session.id,
        chatId,
      });

      if (readinessRequestIdRef.current !== requestId) {
        return;
      }

      setReadiness(readinessPayload);
      setMergeMethod((currentMergeMethod) =>
        readinessPayload.allowedMethods.includes(currentMergeMethod)
          ? currentMergeMethod
          : readinessPayload.defaultMethod,
      );
    } catch (loadError) {
      if (readinessRequestIdRef.current !== requestId) {
        return;
      }

      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load merge readiness",
      );
    } finally {
      if (readinessRequestIdRef.current === requestId) {
        setIsLoadingReadiness(false);
      }
    }
  }, [session.id, chatId]);

  useEffect(() => {
    setTransientPollCount(0);
  }, [session.prNumber]);

  // Load readiness on mount
  useEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      void loadReadiness();
    }
  }, [loadReadiness]);

  useEffect(() => {
    if (!shouldIncrementMergeReadinessTransientPollCount(readiness)) {
      setTransientPollCount(0);
    }
  }, [readiness]);

  useEffect(() => {
    if (
      isLoadingReadiness ||
      !shouldPollMergeReadiness({ readiness, transientPollCount })
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (shouldIncrementMergeReadinessTransientPollCount(readiness)) {
        setTransientPollCount((currentCount) => currentCount + 1);
      }
      void loadReadiness();
    }, MERGE_READINESS_POLL_INTERVAL_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isLoadingReadiness, loadReadiness, readiness, transientPollCount]);

  const canMerge = readiness?.canMerge ?? false;

  /** Resolves to a readable sentence when it failed, or null when it merged. */
  const handleMerge = async (): Promise<string | null> => {
    if (!readiness?.pr) {
      const message = "No pull request found for this session.";
      setError(message);
      return message;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const mergeResult = await mergePr({
        sessionId: session.id,
        chatId,
        mergeMethod,
        deleteBranch,
      });

      if (mergeResult.merged !== true) {
        throw new Error("Failed to merge pull request");
      }

      await onMerged(mergeResult);
      return null;
    } catch (mergeError) {
      const message =
        mergeError instanceof Error
          ? mergeError.message
          : "Failed to merge pull request";
      setError(message);
      return message;
    } finally {
      setIsSubmitting(false);
    }
  };

  const isInitialReadinessLoading = isLoadingReadiness && !readiness;

  const blockers = readiness?.blockers ?? [];
  const blockingBlockers = nonBypassableBlockers(blockers);
  const hasMergeConflicts = hasBlocker(blockers, "conflicts");
  const baseBranchRef = readiness?.pr?.baseBranch
    ? `origin/${readiness.pr.baseBranch}`
    : "origin/main";

  const canForce = readiness?.pr != null && canForceMerge(blockers);

  /*
   * Merging past failing checks asks in the app's own dialog.
   *
   * It used to be a click-twice button that relabelled itself "Click again to
   * confirm" for five seconds. That is a speed bump, not a question: it never
   * says what merging early costs, it is beaten by a double-click, and waiting
   * five seconds silently disarms it. The dialog also carries the consequence
   * the button hides — that this workspace is archived and you are moved off
   * it — and it keeps the spinner and any GitHub error where the decision was
   * made.
   *
   * The ordinary merge button is deliberately left alone: its checks have
   * passed and it is labelled with what it does, down to "& Archive".
   */
  const handleForceClick = async () => {
    await confirmMerge({
      ...forceMergeConfirm({
        baseBranch: readiness?.pr?.baseBranch ?? null,
        deleteBranch,
      }),
      run: handleMerge,
    });
  };

  const allowedMethods = readiness?.allowedMethods ?? ["squash"];
  const hasMultipleMethods = allowedMethods.length > 1;
  const mergeDisabled =
    isSubmitting || isInitialReadinessLoading || !readiness || !readiness.pr;

  const prTitle = readiness?.pr?.title ?? null;
  const prBody = readiness?.pr?.body ?? null;

  if (session.prStatus === "merged") {
    return (
      <div className="space-y-3">
        {prTitle && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-base-content leading-snug">
              {prTitle}
            </p>
            {prBody && (
              <p className="text-xs text-base-content/60 leading-relaxed line-clamp-4 whitespace-pre-line">
                {prBody}
              </p>
            )}
          </div>
        )}
        <div className="relative overflow-hidden rounded-md border border-secondary/30 bg-secondary/10">
          <div className="absolute inset-y-0 left-0 w-1 bg-secondary" />
          <div className="flex items-center gap-2.5 py-3 pr-3 pl-4">
            <GitMerge className="h-4 w-4 shrink-0 text-secondary" />
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-base-content">
                Pull request merged
              </p>
              <p className="text-[11px] text-base-content/60">
                The branch has been merged and can be safely deleted.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* PR title & description */}
      {prTitle && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-base-content leading-snug">
            {prTitle}
          </p>
          {prBody && (
            <p className="text-xs text-base-content/60 leading-relaxed line-clamp-4 whitespace-pre-line">
              {prBody}
            </p>
          )}
        </div>
      )}

      {/* Diff stats */}
      {readiness?.pr &&
        (readiness.pr.changedFiles > 0 ||
          readiness.pr.additions > 0 ||
          readiness.pr.deletions > 0) && (
          <div className="flex items-center gap-3 rounded-md border border-base-300 bg-base-200/30 px-2.5 py-2 text-xs text-base-content/60">
            <span>
              {readiness.pr.changedFiles} file
              {readiness.pr.changedFiles !== 1 ? "s" : ""} changed
            </span>
            {readiness.pr.additions > 0 && (
              <span className="text-success">+{readiness.pr.additions}</span>
            )}
            {readiness.pr.deletions > 0 && (
              <span className="text-error">-{readiness.pr.deletions}</span>
            )}
            {readiness.pr.commits > 0 && (
              <span className="ml-auto flex items-center gap-1 text-base-content/60">
                <GitCommit className="h-3 w-3" />
                {readiness.pr.commits}
              </span>
            )}
          </div>
        )}

      {/* Check runs */}
      <CheckRunsList
        checkRuns={readiness?.checkRuns ?? []}
        checks={
          readiness?.checks.requiredTotal
            ? {
                passed: readiness.checks.passed,
                pending: readiness.checks.pending,
                failed: readiness.checks.failed,
              }
            : undefined
        }
        onRefresh={() => {
          void loadReadiness();
        }}
        isRefreshing={isLoadingReadiness}
        isLoading={isInitialReadinessLoading}
        fixChecksDisabled={isAgentWorking}
        onFixChecks={onFixChecks}
      />

      {blockingBlockers.length > 0 && (
        <div className="relative overflow-hidden rounded-md border border-base-300 bg-base-200/40">
          <div className="absolute inset-y-0 left-0 w-1 bg-warning" />
          <div className="space-y-2.5 py-2.5 pr-2.5 pl-3.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <p className="text-xs font-medium text-base-content">
                Merge blocked
              </p>
            </div>
            <div className="space-y-1 pl-[22px]">
              {blockingBlockers.map((blocker) => (
                <p
                  key={blocker.code}
                  className="text-[11px] leading-snug text-base-content/60"
                >
                  {blocker.message}
                </p>
              ))}
            </div>
            {hasMergeConflicts && onFixConflicts && (
              <div className="pl-[22px]">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={isAgentWorking}
                  onClick={() => {
                    void onFixConflicts(baseBranchRef);
                  }}
                >
                  <Sparkles className="mr-1.5 h-3 w-3" />
                  Fix conflicts
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete branch toggle */}
      <div className="flex items-center justify-between rounded-md border border-base-300 bg-base-200/30 p-2.5">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">Delete source branch</p>
          <p className="text-[10px] text-base-content/60">
            Deletes the PR branch after merge.
          </p>
        </div>
        <Switch
          checked={deleteBranch}
          onCheckedChange={setDeleteBranch}
          disabled={isSubmitting || isInitialReadinessLoading}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-error/10 p-2.5 text-xs text-error">
          {error}
        </div>
      )}

      {/* Merge action */}
      <div className="space-y-2">
        {canMerge ? (
          <div className="flex w-full">
            <Button
              size="sm"
              onClick={() => void handleMerge()}
              disabled={mergeDisabled}
              className={cn(
                "min-w-0 flex-1",
                hasMultipleMethods && "rounded-r-none",
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Merging...
                </>
              ) : (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  {mergeMethodButtonLabels[mergeMethod]}
                </>
              )}
            </Button>
            {hasMultipleMethods && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="default"
                    size="icon"
                    className="h-8 w-8 rounded-l-none border-l border-l-primary-foreground/25"
                    disabled={mergeDisabled}
                    aria-label="Choose merge method"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {allowedMethods.map((method) => (
                    <DropdownMenuItem
                      key={method}
                      className="items-start gap-3 py-2"
                      onSelect={() => setMergeMethod(method)}
                    >
                      <Check
                        className={
                          mergeMethod === method
                            ? "mt-0.5 h-4 w-4"
                            : "mt-0.5 h-4 w-4 opacity-0"
                        }
                      />
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">
                          {mergeMethodLabels[method]}
                        </span>
                        <span className="text-base-content/60 text-[10px]">
                          {mergeMethodDescriptions[method]}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : canForce ? (
          <Button
            size="sm"
            variant="destructive"
            className="w-full"
            onClick={() => void handleForceClick()}
            disabled={isSubmitting || isLoadingReadiness || !readiness?.pr}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <AlertTriangle className="mr-2 h-4 w-4" />
                Merge without passing checks
              </>
            )}
          </Button>
        ) : null}

        {canCloseAndArchive ? (
          <Button
            size="sm"
            variant="destructive"
            className="w-full"
            onClick={onCloseAndArchiveClick}
            disabled={isSubmitting}
          >
            <GitPullRequestClosed className="mr-2 h-4 w-4" />
            Close & Archive
          </Button>
        ) : null}
      </div>

      {mergeConfirmDialog}
    </div>
  );
}
