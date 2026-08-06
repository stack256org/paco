"use client";

import { Pencil, Tag, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { FileEditor } from "./use-file-editor";
import { FileOpenProblem, PanelLoading } from "./file-states";
import { fileName } from "./paths";

/**
 * One open file: its name, what you can do to it, and either the read-only
 * view or the box you type in.
 *
 * Reading is the default and editing is a deliberate step, because most visits
 * to a file are to look at it — and because a textarea that is always live is
 * a textarea you can change by leaning on the keyboard.
 */
export function FileEditorPane({
  path,
  editor,
  readOnlyView,
  onRename,
  onDelete,
  onStartEditing,
  onCancelEditing,
  actionsDisabled,
}: {
  path: string;
  editor: FileEditor;
  /** The syntax-highlighted view, rendered only once the file has loaded. */
  readOnlyView: ReactNode;
  onRename: () => void;
  onDelete: () => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  actionsDisabled: boolean;
}) {
  /*
   * The full path, not the file name.
   *
   * The tab strip directly above already shows the name, so repeating it here
   * put the same word on screen twice in a row and said nothing new. The path
   * is the part the tab has no room for, and it is what tells two files with
   * the same name apart.
   */
  const name = fileName(path);
  const isEditing = editor.draft !== null;
  const canEdit = editor.issue === null && editor.content !== null;
  const handleRetry = () => editor.reload();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-base-300 border-b px-2 py-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span
            className="truncate font-mono text-base-content/60 text-xs"
            title={path}
          >
            {path}
          </span>
          {isEditing ? (
            <span className="badge badge-xs badge-warning badge-soft shrink-0">
              Editing
            </span>
          ) : null}
        </div>

        {isEditing ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className="btn btn-ghost btn-xs gap-1.5"
              disabled={!canEdit || actionsDisabled}
              onClick={onStartEditing}
              type="button"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              Edit
            </button>
            <button
              className="btn btn-ghost btn-xs gap-1.5"
              disabled={actionsDisabled}
              onClick={onRename}
              type="button"
            >
              <Tag aria-hidden="true" className="size-3.5" />
              Rename
            </button>
            <button
              className="btn btn-ghost btn-xs gap-1.5 text-error"
              disabled={actionsDisabled}
              onClick={onDelete}
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isEditing ? (
          <FileTextEditor
            editor={editor}
            name={name}
            onCancel={onCancelEditing}
          />
        ) : editor.issue ? (
          <FileOpenProblem
            issue={editor.issue}
            message={editor.issueMessage}
            onRetry={handleRetry}
          />
        ) : editor.isLoading ? (
          <PanelLoading label="Opening this file…" />
        ) : (
          <div className="h-full overflow-hidden">{readOnlyView}</div>
        )}
      </div>
    </div>
  );
}

function FileTextEditor({
  editor,
  name,
  onCancel,
}: {
  editor: FileEditor;
  name: string;
  onCancel: () => void;
}) {
  const draft = editor.draft ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <textarea
        aria-label={`Contents of ${name}`}
        className="textarea textarea-sm min-h-0 w-full flex-1 resize-none rounded-none font-mono text-xs leading-5"
        onChange={(event) => editor.setDraft(event.target.value)}
        spellCheck={false}
        value={draft}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-base-300 border-t px-2 py-1.5">
        <button
          className="btn btn-primary btn-xs"
          disabled={!editor.isDirty || editor.isSaving}
          onClick={() => void editor.save()}
          type="button"
        >
          {editor.isSaving ? "Saving…" : "Save"}
        </button>
        <button
          className="btn btn-ghost btn-xs"
          disabled={editor.isSaving}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        {/*
          A word, not just a colour: the Save button being dim is not a signal
          on its own, and someone who has just typed needs to be able to tell
          at a glance whether their work is safe.
        */}
        <span className="text-base-content/60 text-xs">
          {editor.isDirty ? "Not saved yet" : "Nothing to save yet"}
        </span>
        {editor.saveError ? (
          <span className="text-error text-xs" role="alert">
            {editor.saveError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
