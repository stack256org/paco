import { getChatById, getSessionById } from "@/lib/db/sessions";
import {
  CHAT_NOT_FOUND,
  SESSION_NOT_FOUND,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";

export type ResponseFormat = "json" | "text";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type ChatRecord = NonNullable<Awaited<ReturnType<typeof getChatById>>>;

type OwnedSessionChatResult =
  | {
      ok: true;
      sessionRecord: SessionRecord;
      chat: ChatRecord;
    }
  | {
      ok: false;
      response: Response;
    };

type OwnedChatByIdResult =
  | {
      ok: true;
      sessionRecord: SessionRecord;
      chat: ChatRecord;
    }
  | {
      ok: false;
      response: Response;
    };

interface RequireOwnedSessionChatParams {
  sessionId: string;
  chatId: string;
  format?: ResponseFormat;
  requireActiveSandbox?: boolean;
  sandboxInactiveMessage?: string;
}

interface RequireOwnedChatByIdParams {
  chatId: string;
  format?: ResponseFormat;
}

function toErrorResponse(
  message: string,
  status: number,
  format: ResponseFormat,
): Response {
  if (format === "text") {
    return new Response(message, { status });
  }

  return Response.json({ error: message }, { status });
}

export async function requireOwnedSessionChat(
  params: RequireOwnedSessionChatParams,
): Promise<OwnedSessionChatResult> {
  const {
    sessionId,
    chatId,
    format = "json",
    requireActiveSandbox = false,
    sandboxInactiveMessage = WORKSPACE_NOT_STARTED,
  } = params;

  const [sessionRecord, chat] = await Promise.all([
    getSessionById(sessionId),
    getChatById(chatId),
  ]);

  if (!sessionRecord) {
    return {
      ok: false,
      response: toErrorResponse(SESSION_NOT_FOUND, 404, format),
    };
  }

  if (!chat || chat.sessionId !== sessionId) {
    return {
      ok: false,
      response: toErrorResponse(CHAT_NOT_FOUND, 404, format),
    };
  }

  if (requireActiveSandbox && !isSandboxActive(sessionRecord.sandboxState)) {
    return {
      ok: false,
      response: toErrorResponse(sandboxInactiveMessage, 400, format),
    };
  }

  return {
    ok: true,
    sessionRecord,
    chat,
  };
}

export async function requireOwnedChatById(
  params: RequireOwnedChatByIdParams,
): Promise<OwnedChatByIdResult> {
  const { chatId, format = "json" } = params;

  const chat = await getChatById(chatId);
  if (!chat) {
    return {
      ok: false,
      response: toErrorResponse(CHAT_NOT_FOUND, 404, format),
    };
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord) {
    return {
      ok: false,
      response: toErrorResponse(SESSION_NOT_FOUND, 404, format),
    };
  }

  return {
    ok: true,
    sessionRecord,
    chat,
  };
}
