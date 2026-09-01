"use client";

import {
  ExternalLink,
  FolderTree,
  GitCompare,
  Monitor,
  RefreshCw,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { FileManager } from "./file-manager/file-manager";
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
} from "./file-manager/unsaved-changes-context";
import { useGitPanel, type WorkspaceTab } from "./git-panel-context";
import { PreviewNotRunning } from "./preview-not-running";
import { PreviewRunControls } from "./preview-run-controls";
import { cn } from "@/lib/utils";

const DiffTabView = dynamic(
  () => import("./diff-tab-view").then((m) => m.DiffTabView),
  { ssr: false },
);

/**
 * The right-hand pane: everything about the workspace that is not the
 * conversation.
 *
 * It replaces a 18rem drawer that could only ever show a file tree or a diff
 * list, and the two things you most wanted to look at — the app the agent just
 * built, and the files it changed — opened in another browser tab, which is to
 * say they left. Both are here instead, so the running app sits beside the
 * conversation that is changing it.
 */

type TabDefinition = {
  id: WorkspaceTab;
  label: string;
  icon: typeof Monitor;
};

const TABS: readonly TabDefinition[] = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "changes", label: "Changes", icon: GitCompare },
];

/**
 * An embedded view of something running inside the sandbox.
 *
 * `key`ed on the reload counter so "Reload" remounts the frame — an iframe will
 * not re-fetch just because its `src` was set to the value it already had.
 */
function EmbeddedFrame({
  url,
  title,
  reloadToken,
}: {
  url: string;
  title: string;
  reloadToken: number;
}) {
  return (
    /*
     * Deliberately unsandboxed.
     *
     * A dev server needs scripts, storage and its own origin to function at
     * all, and `allow-scripts` together with `allow-same-origin` lets a frame
     * drop its own sandbox anyway — the attribute would be a comforting no-op.
     *
     * What actually bounds this is upstream: the frame is the user's own dev
     * server, on a port Paco published from the user's own sandbox container.
     * It is the same code they were already opening in a browser tab;
     * embedding it changes where it renders, not what it can do.
     */
    // oxlint-disable-next-line react/iframe-missing-sandbox -- see above
    <iframe
      className="h-full w-full border-none bg-base-100"
      key={reloadToken}
      src={url}
      title={title}
    />
  );
}

type WorkspacePanelProps = {
  devServerUrl: string | null;
  devServerStarting: boolean;
  devServerStopping: boolean;
  /** Why the last start or stop failed, in the words the server used. */
  devServerError: string | null;
  /** The app's own last output, when it stopped on its own. */
  devServerOutput?: string | null;
  onStartDevServer?: () => void;
  onStopDevServer?: () => void;
  /** False while the sandbox is archived, hibernating or still being created. */
  canRunSandboxActions: boolean;
};

export function WorkspacePanel(props: WorkspacePanelProps) {
  /*
   * The guard wraps the tabs as well as the file manager on purpose.
   *
   * Switching to Preview or Changes takes the editor off screen just as surely
   * as opening another file does, so the tab strip has to be able to ask the
   * same question before it happens.
   */
  return (
    <UnsavedChangesProvider>
      <WorkspacePanelBody {...props} />
    </UnsavedChangesProvider>
  );
}

function WorkspacePanelBody({
  devServerUrl,
  devServerStarting,
  devServerStopping,
  devServerError,
  devServerOutput,
  onStartDevServer,
  onStopDevServer,
  canRunSandboxActions,
}: WorkspacePanelProps) {
  const { workspaceTab, setWorkspaceTab, panelPortalRef, changesCount } =
    useGitPanel();
  const { guard } = useUnsavedChanges();
  const [reloadToken, setReloadToken] = useState(0);

  const isPreview = workspaceTab === "preview";
  const activeUrl = isPreview ? devServerUrl : null;

  return (
    <section
      aria-label="Workspace"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-base-100"
    >
      <div className="flex shrink-0 items-center gap-1 border-base-300 border-b px-1.5 py-1">
        <div className="tabs tabs-box tabs-xs" role="tablist">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = workspaceTab === tab.id;

            return (
              <button
                aria-selected={isActive}
                className={cn("tab gap-1.5", isActive && "tab-active")}
                key={tab.id}
                onClick={() => {
                  // Clicking the tab you are already on changes nothing, so it
                  // must not raise a question about losing work.
                  if (isActive) return;
                  guard(() => setWorkspaceTab(tab.id));
                }}
                role="tab"
                type="button"
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {tab.label}
                {tab.id === "changes" && changesCount > 0 ? (
                  <span className="badge badge-soft badge-xs tabular-nums">
                    {changesCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {activeUrl ? (
            <>
              <button
                aria-label="Reload preview"
                className="btn btn-ghost btn-xs btn-square"
                onClick={() => setReloadToken((token) => token + 1)}
                type="button"
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
              </button>
              <a
                aria-label="Open preview in a new tab"
                className="btn btn-ghost btn-xs btn-square"
                href={activeUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </>
          ) : null}
          {isPreview && canRunSandboxActions ? (
            <PreviewRunControls
              onStart={onStartDevServer}
              onStop={onStopDevServer}
              running={devServerUrl !== null}
              starting={devServerStarting}
              stopping={devServerStopping}
            />
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isPreview ? (
          devServerUrl ? (
            <EmbeddedFrame
              reloadToken={reloadToken}
              title="App preview"
              url={devServerUrl}
            />
          ) : (
            <PreviewNotRunning
              canRun={canRunSandboxActions}
              error={devServerError}
              output={devServerOutput ?? null}
              onStart={canRunSandboxActions ? onStartDevServer : undefined}
              starting={devServerStarting}
            />
          )
        ) : null}

        {/*
          Kept mounted across tab switches.

          An unmount would throw away an edit in progress without asking, which
          is exactly what the guard exists to prevent — and it would also drop
          the guard's own record of that edit, so nothing would be left to ask
          about.
        */}
        <div
          className={cn(
            "h-full",
            workspaceTab === "files" ? "block" : "hidden",
          )}
        >
          <FileManager />
        </div>

        {/*
          The diff and the commit/PR panels are rendered by the chat content,
          which owns their ~28 props. It portals them into this node, so the
          Changes tab stays a placement decision here and a data decision there.

          Both are always on screen together. They used to be separate: the
          diff was here and the commit and pull-request controls only appeared
          if you found a git button in the header, which rendered them into
          this node while the tab was hidden — so the button looked broken and
          the tab looked read-only.
        */}
        <div
          className={cn(
            "h-full",
            workspaceTab === "changes" ? "block" : "hidden",
          )}
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              <DiffTabView />
            </div>
            <div
              className="max-h-96 shrink-0 overflow-y-auto"
              ref={panelPortalRef}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
