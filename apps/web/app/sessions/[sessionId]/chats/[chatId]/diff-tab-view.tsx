"use client";

import { PatchDiff } from "@pierre/diffs/react";
import { AlignJustify, Columns2, Download, Loader2 } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCodeTheme } from "@/hooks/use-code-theme";
import { useDestructiveConfirm } from "@/hooks/use-destructive-confirm";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  type DiffMode,
  useUserPreferences,
} from "@/hooks/use-user-preferences";
import { defaultDiffOptions, splitDiffOptions } from "@/lib/diffs-config";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { chatScopedUrl } from "./chat-scoped-url";
import { DownloadDiffDialog } from "./download-diff-dialog";
import { useGitPanel } from "./git-panel-context";
import { useChatId } from "./hooks/use-chat-id";
import { useSessionChatWorkspaceContext } from "./session-chat-context";
import { sourceControlApi } from "./source-control-api";
import {
  type ChangeRow,
  describeDiscard,
  patchHasBothSides,
  workingTreeRows,
} from "./source-control-contract";
import { SourceControlDiff } from "./source-control-diff";
import { SourceControlPanel } from "./source-control-panel";
import { useSourceControl } from "./use-source-control";

/**
 * The Changes tab.
 *
 * This used to be a list of every file the branch had touched, each with a
 * collapsible patch under it — a report on work that Paco had already
 * committed on the operator's behalf at the end of every turn. Paco no longer
 * does that. A person decides what goes into a commit, so this had to become
 * the surface where that decision is made.
 *
 * Everything below the wiring lives in `source-control-panel`,
 * `source-control-diff` and `use-source-control`; this file exists to connect
 * them to the route, the sandbox, the confirm dialog and the patch renderer,
 * and to hold nothing else.
 */

const WRAPPED_DIFF_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt"];

function shouldWrapDiffContent(filePath: string) {
  const normalized = filePath.toLowerCase();
  return WRAPPED_DIFF_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

function filenameFromContentDisposition(header: string | null): string {
  if (!header) {
    return "changes.diff";
  }
  const match = header.match(/filename="([^"]+)"/);
  return match?.[1] ?? "changes.diff";
}

function sanitizeDiffFilename(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "changes";
}

function createDownloadFilename(value: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hash = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${sanitizeDiffFilename(value)}-${hash}.diff`;
}

function DiffStyleToggle({
  canSplit,
  onChange,
  value,
}: {
  canSplit: boolean;
  onChange: (next: DiffMode) => void;
  value: DiffMode;
}) {
  return (
    <span className="join hidden shrink-0 md:inline-flex">
      <button
        aria-label="Show changes in one column"
        aria-pressed={value === "unified"}
        className={cn(
          "btn join-item btn-xs btn-square",
          value === "unified" ? "btn-active" : "btn-ghost",
        )}
        onClick={() => onChange("unified")}
        title="One column"
        type="button"
      >
        <AlignJustify aria-hidden className="size-3.5" />
      </button>
      <button
        aria-label="Show the old and new version side by side"
        aria-pressed={value === "split" && canSplit}
        className={cn(
          "btn join-item btn-xs btn-square",
          value === "split" && canSplit ? "btn-active" : "btn-ghost",
        )}
        disabled={!canSplit}
        onClick={() => onChange("split")}
        title={
          canSplit
            ? "Show the old and new version next to each other"
            : "Nothing to compare side by side — this file has no older version to put beside it"
        }
        type="button"
      >
        <Columns2 aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

export function DiffTabView() {
  const params = useParams<{ sessionId?: string }>();
  const chatId = useChatId();
  const { sandboxInfo, gitStatus } = useSessionChatWorkspaceContext();
  const { activeView, focusedDiffFile, focusedDiffRequestId, workspaceTab } =
    useGitPanel();
  const { confirm, dialog: confirmDialog } = useDestructiveConfirm();
  const isMobile = useIsMobile();
  const { preferences } = useUserPreferences();
  const codeTheme = useCodeTheme();

  const canMutate = Boolean(sandboxInfo);
  /*
   * The panel stays mounted behind a `hidden` when another workspace tab is
   * showing, so "am I on screen?" is a question about the tab, not the
   * component. Polling a hidden panel would keep a `git status` running for a
   * surface nobody is looking at.
   */
  const isOnScreen = workspaceTab === "changes" || activeView === "diff";

  const confirmDiscard = useCallback(
    (files: ChangeRow[]) => confirm(describeDiscard(files)),
    [confirm],
  );

  const sourceControl = useSourceControl({
    active: isOnScreen && canMutate,
    api: sourceControlApi,
    chatId,
    confirmDiscard,
  });

  const {
    busyKeys,
    commit,
    commitMessage,
    committing,
    clearSelection,
    diff,
    diffError,
    diffLoading,
    discard,
    error,
    loading,
    refresh,
    refreshing,
    select,
    selected,
    setCommitMessage,
    stage,
    status,
    unstage,
  } = sourceControl;

  /*
   * A file clicked in the git sidebar opens here.
   *
   * The unstaged row wins when a file is in both lists: that is the version
   * still being worked on, and the one someone following a link from the
   * conversation means.
   *
   * The ref, rather than a dependency list that leaves `status` out, is what
   * makes this fire once per click. The effect has to re-run as `status`
   * arrives — a click can land before the first `git status` comes back, and
   * the file is not in any list yet to be found — but it must not re-open the
   * file on every poll after that, which would drag the person back out of
   * whatever they had opened since.
   */
  const handledFocusRequest = useRef(0);
  useEffect(() => {
    if (!(focusedDiffFile && status)) {
      return;
    }
    if (handledFocusRequest.current === focusedDiffRequestId) {
      return;
    }
    const inWorking = workingTreeRows(status).some(
      (file) => file.path === focusedDiffFile,
    );
    const inStaged = status.staged.some(
      (file) => file.path === focusedDiffFile,
    );
    if (!(inWorking || inStaged)) {
      return;
    }
    handledFocusRequest.current = focusedDiffRequestId;
    select({ path: focusedDiffFile, staged: !inWorking });
  }, [focusedDiffFile, focusedDiffRequestId, select, status]);

  const [diffStyle, setDiffStyle] = useState<DiffMode>("unified");
  const canSplit = useMemo(
    () => !isMobile && Boolean(diff) && patchHasBothSides(diff?.patch ?? ""),
    [diff, isMobile],
  );

  /*
   * One effect owns the mode, so the preference and the fallback cannot fight.
   * Splitting them meant someone who prefers side-by-side was dropped to one
   * column by the fallback and never came back when a comparable file appeared,
   * because the preference effect had no reason to re-run.
   */
  useEffect(() => {
    if (!canSplit) {
      setDiffStyle("unified");
      return;
    }
    setDiffStyle(preferences?.defaultDiffMode ?? "unified");
  }, [canSplit, preferences?.defaultDiffMode]);

  const renderPatch = useCallback(
    ({ patch, path }: { patch: string; path: string }) => {
      const base =
        diffStyle === "split"
          ? { ...splitDiffOptions, theme: codeTheme }
          : { ...defaultDiffOptions, theme: codeTheme };
      return (
        <PatchDiff
          disableWorkerPool
          key={`${path}-${diffStyle}`}
          options={
            shouldWrapDiffContent(path)
              ? { ...base, overflow: "wrap" as const }
              : base
          }
          patch={patch}
        />
      );
    },
    [codeTheme, diffStyle],
  );

  /* ---------------------------------------------------------------- */
  /* Download — unchanged behaviour, kept because a patch file is the  */
  /* only way to move this work into a checkout outside the sandbox.   */
  /* ---------------------------------------------------------------- */

  const [downloading, setDownloading] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadFilename, setDownloadFilename] = useState<string | null>(null);

  const downloadDiff = useCallback(async () => {
    const sessionId = params.sessionId;
    if (!sessionId) {
      return;
    }
    setDownloading(true);
    try {
      const response = await fetch(
        chatScopedUrl(
          `/api/sessions/${encodeURIComponent(sessionId)}/diff/patch`,
          chatId,
        ),
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof data?.error === "string"
            ? data.error
            : "Failed to download diff",
        );
      }
      const blob = await response.blob();
      const filename =
        downloadFilename ??
        filenameFromContentDisposition(
          response.headers.get("Content-Disposition"),
        );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Diff downloaded");
    } catch (downloadError) {
      toast.error(
        downloadError instanceof Error
          ? downloadError.message
          : "Failed to download diff",
      );
    } finally {
      setDownloading(false);
    }
  }, [chatId, downloadFilename, params.sessionId]);

  const openDownloadDialog = useCallback(() => {
    setDownloadFilename(
      createDownloadFilename(
        gitStatus?.branch ?? sandboxInfo?.currentBranch ?? "changes",
      ),
    );
    setDownloadOpen(true);
  }, [gitStatus?.branch, sandboxInfo?.currentBranch]);

  const hasAnyChange =
    (status?.staged.length ?? 0) +
      (status?.unstaged.length ?? 0) +
      (status?.untracked.length ?? 0) >
    0;
  const canDownload = Boolean(params.sessionId && sandboxInfo && hasAnyChange);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {confirmDialog}
      <DownloadDiffDialog
        canDownload={canDownload}
        downloading={downloading}
        filename={downloadFilename ?? "changes.diff"}
        onDownload={downloadDiff}
        onOpenChange={setDownloadOpen}
        open={downloadOpen}
      />
      <SourceControlPanel
        busyKeys={busyKeys}
        canMutate={canMutate}
        commitMessage={commitMessage}
        committing={committing}
        diff={
          <SourceControlDiff
            diff={diff}
            error={diffError}
            file={selected}
            loading={diffLoading}
            onBack={clearSelection}
            renderPatch={renderPatch}
            toolbar={
              <DiffStyleToggle
                canSplit={canSplit}
                onChange={setDiffStyle}
                value={diffStyle}
              />
            }
          />
        }
        error={error}
        loading={loading}
        onCommit={commit}
        onCommitMessageChange={setCommitMessage}
        onDiscard={discard}
        onRefresh={refresh}
        onSelect={select}
        onStage={stage}
        onUnstage={unstage}
        refreshing={refreshing}
        selected={selected}
        status={status}
        toolbarExtra={
          <button
            aria-label="Download this chat's changes as a patch file"
            className="btn btn-ghost btn-xs btn-square"
            disabled={!canDownload || downloading}
            onClick={openDownloadDialog}
            title="Download this chat's changes as a patch file"
            type="button"
          >
            {downloading ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Download aria-hidden className="size-3.5" />
            )}
          </button>
        }
      />
    </div>
  );
}
