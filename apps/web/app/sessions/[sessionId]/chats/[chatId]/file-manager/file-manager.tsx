"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { FileTree } from "../file-tree";
import { cn } from "@/lib/utils";
import { useGitPanel } from "../git-panel-context";
import {
  useSessionChatMetadataContext,
  useSessionChatWorkspaceContext,
} from "../session-chat-context";
import { EntryNameDialog } from "./entry-name-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FileEditorPane } from "./file-editor-pane";
import { FileManagerToolbar } from "./file-manager-toolbar";
import { PanelLoading, PanelMessage, RetryButton } from "./file-states";
import { OpenFileTabs } from "./open-file-tabs";
import { fileName, joinPath, parentDirectory, renamedPath } from "./paths";
import { useEntryActions } from "./use-entry-actions";
import { useFileEditor } from "./use-file-editor";
import { useOpenFileTabs } from "./use-open-file-tabs";
import {
  useReportUnsavedWork,
  useUnsavedChanges,
} from "./unsaved-changes-context";

/*
 * The highlighted read-only view, loaded on demand.
 *
 * It brings a syntax highlighter with it, which is far too much to put in the
 * bundle for a tab the user may never open. It reads the same SWR key this
 * component does, so by the time it mounts the file is already in the cache.
 */
const FileTabView = dynamic(
  () => import("../file-tab-view").then((m) => m.FileTabView),
  { ssr: false },
);

type DialogState =
  | { kind: "new-file" }
  | { kind: "new-folder" }
  | { kind: "rename"; path: string }
  | { kind: "delete"; path: string }
  | null;

/**
 * Browse, read, edit, create, rename and delete the files in this chat's
 * workspace.
 *
 * Written for someone who does not know git and has never used a terminal:
 * there is no staging, no branch, no path to type unless they want to, and
 * every failure is a sentence rather than a status code. The one thing it
 * refuses to do quietly is lose typed work — see `unsaved-changes-context`.
 */
export function FileManager() {
  const { session } = useSessionChatMetadataContext();
  const { files, filesLoading, filesError, refreshFiles } =
    useSessionChatWorkspaceContext();
  const { focusedFilePath, setFocusedFilePath, openFileTab } = useGitPanel();
  const { guard } = useUnsavedChanges();

  const params = useParams<{ chatId?: string }>();
  const chatId = typeof params.chatId === "string" ? params.chatId : "";

  const [dialog, setDialog] = useState<DialogState>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleSaved = useCallback(() => {
    // A saved file may be a file the tree has never seen, so the list has to
    // catch up before the user goes looking for it.
    void refreshFiles();
  }, [refreshFiles]);

  const tabs = useOpenFileTabs({
    activePath: focusedFilePath,
    setActivePath: setFocusedFilePath,
  });
  const editor = useFileEditor({
    sessionId: session.id,
    chatId,
    path: focusedFilePath,
    onSaved: handleSaved,
  });
  const actions = useEntryActions({
    sessionId: session.id,
    chatId,
    refreshFiles,
  });

  /*
   * Every unsaved file is reported, not just the one on screen.
   *
   * A tab you are not looking at can still be holding an hour of typing, and
   * the questions the guard asks — close this tab, delete this file, leave the
   * panel — are about files, not about whichever one happens to be in front.
   */
  useReportUnsavedWork(editor.dirtyPaths, editor.discardDraft);

  const handleStartEditing = useCallback(() => {
    editor.startEditing();
  }, [editor]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void refreshFiles().finally(() => setIsRefreshing(false));
  }, [refreshFiles]);

  /*
   * New entries land beside whatever the user is looking at.
   *
   * The tree only reports files, not folder selection, so "the folder I am in"
   * is the folder of the open file — and the top level when nothing is open.
   * Both dialogs say which folder that is, so it is never a guess.
   */
  const targetFolder = focusedFilePath ? parentDirectory(focusedFilePath) : "";
  const targetFolderLabel = targetFolder || "the main folder";

  /*
   * Opening a file no longer asks about unsaved work, because it no longer
   * costs any: the file that was open stays open, in its own tab, with its own
   * draft intact.
   */
  const openFile = useCallback(
    (path: string) => openFileTab(path),
    [openFileTab],
  );

  const handleSelectFile = (path: string) => tabs.select(path);

  const handleCloseFile = (path: string) => {
    guard(() => {
      // The guard has already discarded the draft if there was one to lose;
      // this clears an edit that was opened but never typed into, which would
      // otherwise reappear when the file was next opened.
      editor.discardDraft(path);
      tabs.close(path);
    }, path);
  };

  const handleCreate = async (name: string, kind: "file" | "directory") => {
    const path = joinPath(targetFolder, name);
    const failure = await actions.create(path, kind);
    if (failure) return failure;

    setDialog(null);
    // A new folder cannot be opened, and a new file is almost always about to
    // be typed into, so only the file navigates.
    if (kind === "file") openFileTab(path);
    return null;
  };

  const handleRename = async (from: string, name: string) => {
    const to = renamedPath(from, name);
    if (to === from) {
      setDialog(null);
      return null;
    }

    const failure = await actions.rename(from, to);
    if (failure) return failure;

    setDialog(null);
    // The file's tab and its draft both follow it. A rename changes what the
    // file is called, not what is in it or where you were in it.
    editor.moveDraft(from, to);
    tabs.rename(from, to);
    return null;
  };

  const handleDelete = async (path: string) => {
    const failure = await actions.remove(path);
    if (failure) return failure;

    setDialog(null);
    // The file is gone, so its tab has to go with it — a tab pointing at
    // nothing would open onto "This file isn't here any more".
    editor.discardDraft(path);
    tabs.close(path);
    return null;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileManagerToolbar
        disabled={actions.isBusy}
        isRefreshing={isRefreshing}
        onNewFile={() => setDialog({ kind: "new-file" })}
        onNewFolder={() => setDialog({ kind: "new-folder" })}
        onRefresh={handleRefresh}
        // Nothing is lost by uncovering the list: the open files stay open, so
        // this needs no warning and no guard.
        onShowFileList={
          focusedFilePath ? () => setFocusedFilePath(null) : undefined
        }
      />

      {/*
        Two panes, the way a file explorer works: the list stays on the left
        while the open files are on the right.

        It used to swap one for the other, so opening a file hid every other
        file and moving between two of them meant a trip back through "All
        files". Keeping the list in view is the whole point of a file manager.

        They still stack on a narrow screen, where two columns would leave
        neither usable — there the list gives way to the open file, and the
        toolbar's "Files" button brings it back.
      */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-h-0 shrink-0 overflow-y-auto border-base-300 sm:w-64 sm:border-r",
            focusedFilePath ? "hidden sm:block" : "w-full",
          )}
        >
          <FileList
            error={filesError}
            files={files}
            isLoading={filesLoading}
            onOpenFile={openFile}
            onRetry={handleRefresh}
            selectedPath={focusedFilePath}
          />
        </div>

        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            // On a narrow screen this pane is the whole width, so it gives way
            // entirely when there is no file to show.
            focusedFilePath ? "flex" : "hidden sm:flex",
          )}
        >
          {tabs.paths.length > 0 ? (
            <OpenFileTabs
              activePath={focusedFilePath}
              dirtyPaths={editor.dirtyPaths}
              onClose={handleCloseFile}
              onSelect={handleSelectFile}
              paths={tabs.paths}
            />
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden">
            {focusedFilePath ? (
              <FileEditorPane
                actionsDisabled={actions.isBusy}
                editor={editor}
                onCancelEditing={() =>
                  guard(
                    () => editor.discardDraft(focusedFilePath),
                    focusedFilePath,
                  )
                }
                onDelete={() =>
                  guard(
                    () => setDialog({ kind: "delete", path: focusedFilePath }),
                    focusedFilePath,
                  )
                }
                onRename={() =>
                  setDialog({ kind: "rename", path: focusedFilePath })
                }
                onStartEditing={handleStartEditing}
                path={focusedFilePath}
                readOnlyView={<FileTabView />}
              />
            ) : (
              <PanelMessage
                detail="Choose a file on the left to read it, then press Edit to make a change."
                title="No file open"
              />
            )}
          </div>
        </div>
      </div>

      {/*
        Each dialog is mounted only while it is open.

        Kept mounted, they would still be holding whatever was typed last time:
        someone who created `notes.md` and then chose New file again would find
        `notes.md` waiting in the box, and creating two files in a row would
        fail on the second with "there's already a file with that name".
      */}
      {dialog?.kind === "new-file" ? (
        <EntryNameDialog
          busyLabel="Creating…"
          confirmLabel="Create file"
          description={`It will be created in ${targetFolderLabel}, empty and ready to type in.`}
          label="File name"
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSubmit={(name) => handleCreate(name, "file")}
          open
          placeholder="notes.md"
          title="New file"
        />
      ) : null}

      {dialog?.kind === "new-folder" ? (
        <EntryNameDialog
          busyLabel="Creating…"
          confirmLabel="Create folder"
          description={`It will be created inside ${targetFolderLabel}.`}
          label="Folder name"
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSubmit={(name) => handleCreate(name, "directory")}
          open
          placeholder="notes"
          title="New folder"
        />
      ) : null}

      {dialog?.kind === "rename" ? (
        <EntryNameDialog
          busyLabel="Renaming…"
          confirmLabel="Rename"
          description="Only the name changes. What's inside the file stays exactly as it is."
          initialValue={fileName(dialog.path)}
          key={dialog.path}
          label="New name"
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSubmit={(name) => handleRename(dialog.path, name)}
          open
          title={`Rename ${fileName(dialog.path)}`}
        />
      ) : null}

      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          busyLabel="Deleting…"
          confirmLabel="Delete file"
          description={`"${fileName(dialog.path)}" will be removed from this workspace. This can't be undone.`}
          destructive
          key={dialog.path}
          onConfirm={() => handleDelete(dialog.path)}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          open
          title={`Delete ${fileName(dialog.path)}?`}
        />
      ) : null}
    </div>
  );
}

function FileList({
  files,
  isLoading,
  error,
  onOpenFile,
  onRetry,
  selectedPath,
}: {
  files: ReturnType<typeof useSessionChatWorkspaceContext>["files"];
  isLoading: boolean;
  error: string | null;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
  /** Highlighted in the list so it is obvious which file is on the right. */
  selectedPath: string | null;
}) {
  if (error) {
    return (
      <PanelMessage detail={error} title="We couldn't show your files">
        <RetryButton onRetry={onRetry} />
      </PanelMessage>
    );
  }

  if (isLoading && !files) {
    return <PanelLoading label="Looking for your files…" />;
  }

  if (!files || files.length === 0) {
    return (
      <PanelMessage
        detail="Choose New file above to make your first one, or ask the assistant in the chat to build something for you."
        title="No files yet"
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-selected-path={selectedPath}>
      <FileTree files={files} onFileClick={onOpenFile} />
    </div>
  );
}
