import { requireOwnedSessionChat } from "@/app/api/sessions/_lib/session-context";
import { markChatRead } from "@/lib/db/sessions";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

export async function POST(_req: Request, context: RouteContext) {
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  await markChatRead(chatId);
  return Response.json({ success: true });
}
