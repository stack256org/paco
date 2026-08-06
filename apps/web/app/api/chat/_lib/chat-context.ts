import { getChatById, getSessionById } from "@/lib/db/sessions";
import {
  CHAT_NOT_FOUND,
  NOT_YOURS,
  SESSION_NOT_FOUND,
  SIGNED_OUT,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";
import { isSandboxActive } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

export type ResponseFormat = "json" | "text";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type ChatRecord = NonNullable<Awaited<ReturnType<typeof getChatById>>>;

type AuthenticatedUserResult =
  | {
      ok: true;
      userId: string;
    }
  | {
      ok: false;
      response: Response;
    };

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
  userId: string;
  sessionId: string;
  chatId: string;
  format?: ResponseFormat;
  forbiddenMessage?: string;
  requireActiveSandbox?: boolean;
  sandboxInactiveMessage?: string;
}

interface RequireOwnedChatByIdParams {
  userId: string;
  chatId: string;
  format?: ResponseFormat;
  forbiddenMessage?: string;
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

export async function requireAuthenticatedUser(
  format: ResponseFormat = "json",
): Promise<AuthenticatedUserResult> {
  const session = await getServerSession();
  if (!session?.user) {
    return {
      ok: false,
      response: toErrorResponse(SIGNED_OUT, 401, format),
    };
  }

  return {
    ok: true,
    userId: session.user.id,
  };
}

export async function requireOwnedSessionChat(
  params: RequireOwnedSessionChatParams,
): Promise<OwnedSessionChatResult> {
  const {
    userId,
    sessionId,
    chatId,
    format = "json",
    forbiddenMessage = NOT_YOURS,
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

  if (sessionRecord.userId !== userId) {
    return {
      ok: false,
      response: toErrorResponse(forbiddenMessage, 403, format),
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
  const {
    userId,
    chatId,
    format = "json",
    forbiddenMessage = NOT_YOURS,
  } = params;

  const chat = await getChatById(chatId);
  if (!chat) {
    return {
      ok: false,
      response: toErrorResponse(CHAT_NOT_FOUND, 404, format),
    };
  }

  const sessionRecord = await getSessionById(chat.sessionId);
  if (!sessionRecord || sessionRecord.userId !== userId) {
    return {
      ok: false,
      response: toErrorResponse(forbiddenMessage, 403, format),
    };
  }

  return {
    ok: true,
    sessionRecord,
    chat,
  };
}
