import { notFound, redirect } from "next/navigation";
import { getChatsBySessionId } from "@/lib/db/sessions";
import { getSessionByIdCached } from "@/lib/db/sessions-cache";

interface SessionPageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function SessionPage({ params }: SessionPageProps) {
  const { sessionId } = await params;

  const sessionRecord = await getSessionByIdCached(sessionId);
  if (!sessionRecord) {
    notFound();
  }

  const chats = await getChatsBySessionId(sessionId);
  const targetChat = chats[0];

  if (!targetChat) {
    notFound();
  }

  redirect(`/sessions/${sessionId}/chats/${targetChat.id}`);
}
