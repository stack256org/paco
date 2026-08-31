import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getChatSummariesBySessionId } from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";
import { getUserPreferences } from "@/lib/db/user-preferences";
import { getSoleUserId } from "@/lib/db/users";
import { SessionLayoutShell } from "./session-layout-shell";

interface SessionLayoutProps {
  params: Promise<{ sessionId: string }>;
  children: ReactNode;
}

export default async function SessionLayout({
  params,
  children,
}: SessionLayoutProps) {
  const { sessionId } = await params;

  const sessionRecord = await getSessionByIdCached(sessionId);
  if (!sessionRecord) {
    notFound();
  }

  let initialChatsData:
    | {
        chats: Awaited<ReturnType<typeof getChatSummariesBySessionId>>;
        defaultModelId: string | null;
      }
    | undefined;

  try {
    const [chats, rawPreferences] = await Promise.all([
      getChatSummariesBySessionId(sessionId),
      getUserPreferences(await getSoleUserId()),
    ]);
    const preferences = rawPreferences;
    initialChatsData = {
      chats,
      defaultModelId: preferences.defaultModelId,
    };
  } catch (error) {
    console.error("Failed to prefetch session chat data:", error);
  }

  return (
    <SessionLayoutShell
      session={sessionRecord}
      initialChatsData={initialChatsData}
    >
      {children}
    </SessionLayoutShell>
  );
}
