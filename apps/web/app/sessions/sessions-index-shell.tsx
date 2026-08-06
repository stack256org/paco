"use client";

import { MessageSquare, Plus } from "lucide-react";
import { ArchivedWorkspacesSection } from "@/components/archived-workspaces-section";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useSessionsShell } from "./sessions-shell-context";

/**
 * What you see at /sessions with nothing open yet.
 *
 * This used to render a `SidebarTrigger`, which throws
 * "useSidebar must be used within a SidebarProvider" now that the sidebar is
 * gone — so archiving a session, which redirects here, crashed the page. There
 * was nothing else in that header, so it went with it.
 */
export function SessionsIndexShell() {
  const {
    openNewSessionDialog,
    archivedCount,
    onSessionSelect,
    onSessionRestored,
  } = useSessionsShell();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquare />
          </EmptyMedia>
          <EmptyTitle>Nothing open</EmptyTitle>
          <EmptyDescription>
            Pick a session from the switcher at the top, or start a new one and
            describe what you want built.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={openNewSessionDialog}>
            <Plus className="h-4 w-4" />
            New session
          </Button>
        </EmptyContent>
      </Empty>

      {/*
        Archiving your last workspace lands you here, with no header and so no
        switcher. Without this the thing you just archived would be genuinely
        unreachable from the page you were sent to.
      */}
      <ArchivedWorkspacesSection
        archivedCount={archivedCount}
        onOpen={onSessionSelect}
        onRestored={onSessionRestored}
        surface="panel"
      />
    </div>
  );
}
