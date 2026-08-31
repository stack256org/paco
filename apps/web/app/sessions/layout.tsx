import type { ReactNode } from "react";
import { getLastRepo } from "@/lib/db/last-repo";
import {
  getArchivedSessionCount,
  getSessionsWithUnread,
} from "@/lib/db/sessions";
import { SessionsRouteShell } from "./sessions-route-shell";

type SessionsLayoutProps = {
  children: ReactNode;
};

export default async function SessionsLayout({
  children,
}: SessionsLayoutProps) {
  const [lastRepo, sessions, archivedCount] = await Promise.all([
    getLastRepo(),
    getSessionsWithUnread({ status: "active" }),
    getArchivedSessionCount(),
  ]);

  return (
    <SessionsRouteShell
      initialSessionsData={{ sessions, archivedCount }}
      lastRepo={lastRepo}
    >
      {children}
    </SessionsRouteShell>
  );
}
