import { requireOwnedSessionChat } from "@/app/api/sessions/_lib/session-context";
import type { WebAgentUIMessage } from "@/app/types";
import {
  updateChatAssistantActivity,
  upsertChatMessageScoped,
} from "@/lib/db/sessions";
import { BAD_REQUEST } from "@/lib/error-copy";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

type PersistAssistantMessageRequest = {
  message: WebAgentUIMessage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAssistantMessage(value: unknown): value is WebAgentUIMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.role === "assistant" &&
    Array.isArray(value.parts)
  );
}

export async function POST(req: Request, context: RouteContext) {
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  let body: PersistAssistantMessageRequest;
  try {
    body = (await req.json()) as PersistAssistantMessageRequest;
  } catch {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const message = isRecord(body) ? body.message : undefined;
  if (!isAssistantMessage(message)) {
    return Response.json({ error: BAD_REQUEST }, { status: 400 });
  }

  const result = await upsertChatMessageScoped({
    id: message.id,
    chatId,
    role: "assistant",
    parts: message,
  });

  if (result.status === "conflict") {
    return Response.json({ error: BAD_REQUEST }, { status: 409 });
  }

  if (result.status === "inserted") {
    await updateChatAssistantActivity(chatId, new Date());
  }

  return Response.json({ success: true, status: result.status });
}
