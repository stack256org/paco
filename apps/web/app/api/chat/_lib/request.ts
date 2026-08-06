import type { WebAgentUIMessage } from "@/app/types";
import { BAD_REQUEST } from "@/lib/error-copy";

export interface ChatRequestBody {
  messages: WebAgentUIMessage[];
  sessionId?: string;
  chatId?: string;
}

type ParseChatRequestResult =
  | {
      ok: true;
      body: ChatRequestBody;
    }
  | {
      ok: false;
      response: Response;
    };

type RequireChatIdentifiersResult =
  | {
      ok: true;
      sessionId: string;
      chatId: string;
    }
  | {
      ok: false;
      response: Response;
    };

export async function parseChatRequestBody(
  req: Request,
): Promise<ParseChatRequestResult> {
  try {
    const body = (await req.json()) as ChatRequestBody;
    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: BAD_REQUEST }, { status: 400 }),
    };
  }
}

export function requireChatIdentifiers(
  body: ChatRequestBody,
): RequireChatIdentifiersResult {
  if (!body.sessionId || !body.chatId) {
    return {
      ok: false,
      response: Response.json({ error: BAD_REQUEST }, { status: 400 }),
    };
  }

  return {
    ok: true,
    sessionId: body.sessionId,
    chatId: body.chatId,
  };
}
