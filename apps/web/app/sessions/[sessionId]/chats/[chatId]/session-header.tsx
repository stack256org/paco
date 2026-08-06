"use client";

import { ExternalLink } from "lucide-react";
import { AppAccountMenu } from "@/components/app-account-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useSessionsShell } from "@/app/sessions/sessions-shell-context";
import { useGitPanel } from "./git-panel-context";
import { useSessionLayout } from "@/app/sessions/[sessionId]/session-layout-context";

/**
 * Session header that uses only layout-level data (persists across chat switches).
 * Sandbox-specific props are removed to prevent layout shift during navigation.
 *
 * It carries no workspace controls of its own any more. Commit and pull
 * request live in the Changes tab, start and stop live in the Preview tab —
 * next to the thing each one acts on, instead of in a corner of the screen
 * that gave no clue which pane would react.
 */
export function SessionHeader() {
  const {
    sessions,
    archivedCount,
    sessionsLoading,
    activeSessionId,
    currentUser,
    openNewSessionDialog,
    onSessionSelect,
    onSessionPrefetch,
    onSessionArchive,
    onSessionRestored,
  } = useSessionsShell();
  const { headerActionsRef } = useGitPanel();
  const { session } = useSessionLayout();

  return (
    <header className="border-b border-base-300 px-3 py-1.5">
      <div className="flex items-center justify-between gap-2">
        {/* Left side: workspace switcher + repo/branch */}
        <div className="flex min-w-0 items-center gap-2">
          <WorkspaceSwitcher
            activeSessionId={activeSessionId}
            activeTitle={session.title}
            archivedCount={archivedCount}
            loading={sessionsLoading}
            onArchive={onSessionArchive}
            onCreate={openNewSessionDialog}
            onPrefetch={onSessionPrefetch}
            onRestore={onSessionRestored}
            onSelect={onSessionSelect}
            sessions={sessions}
          />

          <div className="flex min-w-0 items-center gap-1.5 text-sm">
            {session.repoName && (
              <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
                {session.cloneUrl ? (
                  /* oxlint-disable-next-line nextjs/no-html-link-for-pages */
                  <a
                    href={`https://github.com/${session.repoOwner}/${session.repoName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 truncate font-medium text-base-content hover:underline"
                  >
                    {session.repoName}
                    <ExternalLink className="h-3 w-3 shrink-0 text-base-content/60" />
                  </a>
                ) : (
                  <span className="truncate font-medium text-base-content">
                    {session.repoName}
                  </span>
                )}
                {session.branch && (
                  <>
                    <span className="text-base-content/40">/</span>
                    <span className="truncate font-mono text-base-content/60">
                      {session.branch}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right side: the deployed-preview link, then the account menu */}
        <div className="flex items-center gap-1">
          {/* Portal target for chat-level header actions */}
          <div ref={headerActionsRef} className="flex items-center" />

          <AppAccountMenu user={currentUser} />
        </div>
      </div>
    </header>
  );
}
