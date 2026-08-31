"use client";

import type { ReactNode } from "react";
import { createContext, useContext } from "react";

import type { SessionWithUnread } from "@/hooks/use-sessions";

/**
 * What the session shell knows and the top bar needs.
 *
 * The workspace switcher lives in the session header, several levels below the
 * shell that owns the session list and its navigation handlers. This carries
 * them down rather than threading props through the layouts in between.
 */
type SessionsShellContextValue = {
  openNewSessionDialog: () => void;
  sessions: SessionWithUnread[];
  /** Archived workspaces are not in `sessions`; this is only how many there are. */
  archivedCount: number;
  sessionsLoading: boolean;
  activeSessionId: string;
  onSessionSelect: (session: SessionWithUnread) => void;
  onSessionPrefetch: (session: SessionWithUnread) => void;
  onSessionArchive: (session: SessionWithUnread) => void;
  /** Open a workspace that has just been restored from the archive. */
  onSessionRestored: (session: SessionWithUnread) => void;
};

const SessionsShellContext = createContext<
  SessionsShellContextValue | undefined
>(undefined);

export function SessionsShellProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: SessionsShellContextValue;
}) {
  return (
    <SessionsShellContext.Provider value={value}>
      {children}
    </SessionsShellContext.Provider>
  );
}

export function useSessionsShell() {
  const context = useContext(SessionsShellContext);

  if (!context) {
    throw new Error(
      "useSessionsShell must be used within SessionsShellProvider",
    );
  }

  return context;
}
