"use client";

import {
  ArrowRight,
  Check,
  GitCommitHorizontal,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  type ChangeRow,
  commitBlocker,
  commitBlockerMessage,
  fileRowKey,
  isSameFile,
  type SelectedFile,
  splitPath,
  stagedRows,
  statusLabel,
  statusLetter,
  statusToneClass,
  totalChangeCount,
  type WorkingTreeStatus,
  workingTreeRows,
} from "./source-control-contract";

/**
 * The Changes tab, rebuilt as a source-control panel.
 *
 * Paco used to commit on its own at the end of every turn, so this surface only
 * ever had to *report* what had happened. It now has to let a person decide:
 * two lists, `STAGED CHANGES` and `CHANGES`, git's real index behind them, and
 * a commit that takes exactly what is staged.
 *
 * The list is flat. A folder tree was the obvious alternative and the wrong
 * one — a turn touches a handful of files scattered across the repository, and
 * a tree spends most of its height on directories that have one child.
 *
 * Everything here is a prop. The component holds no state and calls no server
 * action, which is what lets each of the states this kind of panel gets wrong
 * — nothing changed, nothing staged, a file in both lists at once — be
 * rendered on its own and looked at.
 */

export type SourceControlPanelProps = {
  status: WorkingTreeStatus | null;
  /** First load only. A refresh keeps the previous list on screen. */
  loading: boolean;
  refreshing: boolean;
  error: string | null;

  selected: SelectedFile | null;
  onSelect: (file: SelectedFile) => void;

  onStage: (files: ChangeRow[]) => void;
  onUnstage: (files: ChangeRow[]) => void;
  onDiscard: (files: ChangeRow[]) => void;
  onRefresh: () => void;

  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  onCommit: () => void;
  committing: boolean;

  /** Rows with an action in flight, keyed by `fileRowKey`. */
  busyKeys: ReadonlySet<string>;
  /** False while the sandbox is offline: the lists are readable, not editable. */
  canMutate: boolean;

  /** The diff pane. Passed in so this file never imports the patch renderer. */
  diff: ReactNode;
  /** Extra controls for the header, such as Download. */
  toolbarExtra?: ReactNode;
};

/**
 * The one-character status column.
 *
 * The letter comes from `statusLetter`, not straight off the row: git reports
 * an untracked file as `A`, and showing that would give an untracked file and
 * a staged addition the same mark for two states that differ in exactly the
 * way this list exists to show. VS Code writes `U` there, and so do we.
 */
function StatusLetter({ file }: { file: ChangeRow }) {
  const label = statusLabel(file.status, file.untracked);

  return (
    <span
      className={cn(
        "w-3.5 shrink-0 text-center font-mono font-semibold text-xs",
        statusToneClass(file.status, file.untracked),
      )}
      title={label}
    >
      <span className="sr-only">{label}: </span>
      <span aria-hidden>{statusLetter(file.status, file.untracked)}</span>
    </span>
  );
}

function RowAction({
  busy,
  disabled,
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  busy: boolean;
  disabled: boolean;
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  tone?: string;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "btn btn-ghost btn-xs btn-square shrink-0 opacity-70 transition-opacity hover:opacity-100",
        tone,
      )}
      disabled={disabled || busy}
      onClick={onClick}
      title={label}
      type="button"
    >
      {busy ? (
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      ) : (
        <Icon aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

/**
 * The path, as a row label.
 *
 * Two rules decide what survives when the row is too narrow, and both were
 * settled by looking at it rather than by reasoning about it:
 *
 * The *file name* is the last thing to go. The directory is `flex-1`, so its
 * flex basis is zero and it gives up its width first; the name keeps its own
 * width and only then truncates. A row that has shortened to a bare file name
 * is still useful, and one that has shortened to a directory is not.
 *
 * A rename shows both halves, and the half that shrinks is the old path. The
 * first version put the old path first at full width, which is exactly what a
 * rename reads like — and at a sidebar's width it pushed the name the file
 * actually has now off the end of the row. The full pair is on the row's
 * tooltip and in the diff header either way.
 */
function RowLabel({ file }: { file: ChangeRow }) {
  const { fileName, dirPath } = splitPath(file.path);

  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden text-left">
      {file.oldPath ? (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-base-content/45">
            {file.oldPath}
          </span>
          <ArrowRight
            aria-hidden
            className="size-3 shrink-0 self-center text-base-content/45"
          />
        </>
      ) : null}
      <span className="min-w-0 truncate font-medium font-mono text-base-content text-xs">
        {fileName}
      </span>
      {dirPath ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-base-content/50">
          {dirPath}
        </span>
      ) : null}
    </span>
  );
}

function FileRow({
  file,
  staged,
  selected,
  busy,
  canMutate,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: ChangeRow;
  staged: boolean;
  selected: boolean;
  busy: boolean;
  canMutate: boolean;
  onSelect: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <li
      className={cn(
        "group flex min-w-0 items-center gap-0.5 rounded-field pr-1 pl-2 transition-colors",
        selected ? "bg-base-300" : "hover:bg-base-200",
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        onClick={onSelect}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        type="button"
      >
        <RowLabel file={file} />
      </button>
      {staged ? (
        <RowAction
          busy={busy}
          disabled={!canMutate}
          icon={Minus}
          label={`Unstage ${file.path}`}
          onClick={onUnstage}
        />
      ) : (
        <>
          <RowAction
            busy={busy}
            disabled={!canMutate}
            icon={Undo2}
            label={`Discard changes in ${file.path}`}
            onClick={onDiscard}
            tone="hover:text-error"
          />
          <RowAction
            busy={busy}
            disabled={!canMutate}
            icon={Plus}
            label={`Stage ${file.path}`}
            onClick={onStage}
          />
        </>
      )}
      <StatusLetter file={file} />
    </li>
  );
}

function SectionHeaderAction({
  disabled,
  icon: Icon,
  label,
  onClick,
  tone,
}: {
  disabled: boolean;
  icon: typeof Plus;
  label: string;
  onClick: () => void;
  tone?: string;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "btn btn-ghost btn-xs btn-square shrink-0 opacity-70 transition-opacity hover:opacity-100",
        tone,
      )}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden className="size-3.5" />
    </button>
  );
}

function ChangeSection({
  actions,
  children,
  count,
  title,
}: {
  actions: ReactNode;
  children: ReactNode;
  count: number;
  title: string;
}) {
  return (
    <section className="min-w-0">
      <div className="sticky top-0 z-10 flex min-w-0 items-center gap-2 bg-base-100 px-2 py-1.5">
        <h3 className="min-w-0 truncate font-semibold text-[11px] text-base-content/70 uppercase tracking-wider">
          {title}
        </h3>
        <span className="badge badge-ghost badge-xs shrink-0 font-mono">
          {count}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {actions}
        </span>
      </div>
      <ul className="min-w-0 space-y-px px-1 pb-2">{children}</ul>
    </section>
  );
}

function CleanState() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-success/15 text-success">
        <Check aria-hidden className="size-5" />
      </span>
      <p className="font-medium text-base-content/80 text-sm">
        No changes to commit
      </p>
      <p className="max-w-64 text-balance text-[11px] text-base-content/55 leading-relaxed">
        The workspace matches the last commit. Anything the agent edits shows up
        here.
      </p>
    </div>
  );
}

export function SourceControlPanel({
  status,
  loading,
  refreshing,
  error,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onRefresh,
  commitMessage,
  onCommitMessageChange,
  onCommit,
  committing,
  busyKeys,
  canMutate,
  diff,
  toolbarExtra,
}: SourceControlPanelProps) {
  const staged = status ? stagedRows(status) : [];
  const working = status ? workingTreeRows(status) : [];
  const total = totalChangeCount(status);
  const aheadOfBase = status?.aheadOfBase ?? 0;

  const blocker = commitBlocker({
    canMutate,
    committing,
    stagedCount: staged.length,
    message: commitMessage,
  });
  const blockerMessage = commitBlockerMessage(blocker);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col lg:flex-row">
      {/*
        The list is a sidebar on a wide layout and the whole pane on a narrow
        one, where opening a file replaces it. Both halves stay in the markup —
        swapping them with `hidden` rather than unmounting keeps a half-typed
        commit message and the list's scroll position alive across every trip
        into a file and back.
      */}
      <aside
        className={cn(
          "flex min-h-0 min-w-0 flex-col border-base-300 lg:w-80 lg:shrink-0 lg:border-r xl:w-96",
          selected && "hidden lg:flex",
        )}
      >
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-base-300 border-b px-3 py-2">
          <h2 className="min-w-0 truncate font-semibold text-sm">
            Source Control
          </h2>
          {total > 0 ? (
            <span className="badge badge-neutral badge-xs shrink-0 font-mono">
              {total}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {toolbarExtra}
            <button
              aria-label="Refresh the list of changes"
              className="btn btn-ghost btn-xs btn-square"
              disabled={refreshing}
              onClick={onRefresh}
              title="Refresh the list of changes"
              type="button"
            >
              <RefreshCw
                aria-hidden
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
            </button>
          </span>
        </div>

        <div className="shrink-0 border-base-300 border-b p-2">
          <Textarea
            aria-label="Commit message"
            className="min-h-16 resize-none font-mono text-xs"
            disabled={!canMutate || committing}
            onChange={(event) => onCommitMessageChange(event.target.value)}
            placeholder="Message (what changed, and why)"
            rows={2}
            value={commitMessage}
          />
          <button
            className="btn btn-primary btn-sm mt-2 w-full"
            disabled={blocker !== null}
            onClick={onCommit}
            type="button"
          >
            {committing ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal aria-hidden className="size-3.5" />
            )}
            {committing
              ? "Committing…"
              : `Commit${staged.length > 0 ? ` ${staged.length} staged` : ""}`}
          </button>
          {/*
            A plain paragraph, not daisyUI's `.label`. That class is
            `inline-flex`, so a sentence inside one lays its words out as flex
            items and shatters into a column the moment it has to wrap.
          */}
          {blockerMessage ? (
            <p className="mt-1.5 px-0.5 text-[11px] text-base-content/60 leading-snug">
              {blockerMessage}
            </p>
          ) : null}
          {aheadOfBase > 0 ? (
            <p className="mt-1.5 px-0.5 text-[11px] text-base-content/50 leading-snug">
              {aheadOfBase} {aheadOfBase === 1 ? "commit" : "commits"} on this
              branch {aheadOfBase === 1 ? "is" : "are"} not on the base branch
              yet.
            </p>
          ) : null}
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-base-content/60 text-sm">
              <Loader2 aria-hidden className="size-4 animate-spin" />
              Reading the workspace…
            </div>
          ) : null}

          {error && !loading ? (
            <div className="m-2 rounded-box border border-error/30 bg-error/10 p-3">
              <p className="wrap-anywhere text-error text-xs leading-relaxed">
                {error}
              </p>
            </div>
          ) : null}

          {!(loading || error) && total === 0 ? <CleanState /> : null}

          {staged.length > 0 ? (
            <ChangeSection
              actions={
                <SectionHeaderAction
                  disabled={!canMutate}
                  icon={Minus}
                  label="Unstage all changes"
                  onClick={() => onUnstage(staged)}
                />
              }
              count={staged.length}
              title="Staged changes"
            >
              {staged.map((file) => {
                const rowFile: SelectedFile = { path: file.path, staged: true };
                const key = fileRowKey(rowFile);
                return (
                  <FileRow
                    busy={busyKeys.has(key)}
                    canMutate={canMutate}
                    file={file}
                    key={key}
                    onDiscard={() => onDiscard([file])}
                    onSelect={() => onSelect(rowFile)}
                    onStage={() => onStage([file])}
                    onUnstage={() => onUnstage([file])}
                    selected={isSameFile(selected, rowFile)}
                    staged
                  />
                );
              })}
            </ChangeSection>
          ) : null}

          {working.length > 0 ? (
            <ChangeSection
              actions={
                <>
                  <SectionHeaderAction
                    disabled={!canMutate}
                    icon={Undo2}
                    label="Discard all changes"
                    onClick={() => onDiscard(working)}
                    tone="hover:text-error"
                  />
                  <SectionHeaderAction
                    disabled={!canMutate}
                    icon={Plus}
                    label="Stage all changes"
                    onClick={() => onStage(working)}
                  />
                </>
              }
              count={working.length}
              title="Changes"
            >
              {working.map((file) => {
                const rowFile: SelectedFile = {
                  path: file.path,
                  staged: false,
                };
                const key = fileRowKey(rowFile);
                return (
                  <FileRow
                    busy={busyKeys.has(key)}
                    canMutate={canMutate}
                    file={file}
                    key={key}
                    onDiscard={() => onDiscard([file])}
                    onSelect={() => onSelect(rowFile)}
                    onStage={() => onStage([file])}
                    onUnstage={() => onUnstage([file])}
                    selected={isSameFile(selected, rowFile)}
                    staged={false}
                  />
                );
              })}
            </ChangeSection>
          ) : null}
        </div>
      </aside>

      <section
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          !selected && "hidden lg:flex",
        )}
      >
        {diff}
      </section>
    </div>
  );
}
