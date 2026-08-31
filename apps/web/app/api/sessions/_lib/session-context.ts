import * as sessionsDb from "@/lib/db/sessions";
import {
  SESSION_NOT_FOUND,
  CHAT_NOT_FOUND,
  WORKSPACE_NOT_STARTED,
} from "@/lib/error-copy";

export type SessionRecord = NonNullable<
  Awaited<ReturnType<typeof sessionsDb.getSessionById>>
>;
export type ChatRecord = NonNullable<
  Awaited<ReturnType<typeof sessionsDb.getChatById>>
>;

type OwnedSessionResult =
  | {
      ok: true;
      sessionRecord: SessionRecord;
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

interface RequireOwnedSessionParams {
  sessionId: string;
}

interface RequireOwnedSessionChatParams {
  sessionId: string;
  chatId: string;
}

interface RequireOwnedSessionWithSandboxGuardParams extends RequireOwnedSessionParams {
  sandboxGuard: (sandboxState: SessionRecord["sandboxState"]) => boolean;
  sandboxErrorMessage?: string;
  sandboxErrorStatus?: number;
}

function toErrorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Look up a session by id.
 *
 * Named "owned" for historical reasons — the instance has exactly one
 * tenant, so there is no separate owner to check against; existing the
 * session is the only thing left to verify.
 */
export async function requireOwnedSession(
  params: RequireOwnedSessionParams,
): Promise<OwnedSessionResult> {
  const { sessionId } = params;

  const sessionRecord = await sessionsDb.getSessionById(sessionId);
  if (!sessionRecord) {
    return {
      ok: false,
      response: toErrorResponse(SESSION_NOT_FOUND, 404),
    };
  }

  return {
    ok: true,
    sessionRecord,
  };
}

export async function requireOwnedSessionWithSandboxGuard(
  params: RequireOwnedSessionWithSandboxGuardParams,
): Promise<OwnedSessionResult> {
  const {
    sessionId,
    sandboxGuard,
    sandboxErrorMessage = WORKSPACE_NOT_STARTED,
    sandboxErrorStatus = 400,
  } = params;

  const ownedSessionResult = await requireOwnedSession({ sessionId });
  if (!ownedSessionResult.ok) {
    return ownedSessionResult;
  }

  if (!sandboxGuard(ownedSessionResult.sessionRecord.sandboxState)) {
    return {
      ok: false,
      response: toErrorResponse(sandboxErrorMessage, sandboxErrorStatus),
    };
  }

  return ownedSessionResult;
}

export async function requireOwnedSessionChat(
  params: RequireOwnedSessionChatParams,
): Promise<OwnedSessionChatResult> {
  const { sessionId, chatId } = params;

  const [sessionRecord, chat] = await Promise.all([
    sessionsDb.getSessionById(sessionId),
    sessionsDb.getChatById(chatId),
  ]);

  if (!sessionRecord) {
    return {
      ok: false,
      response: toErrorResponse(SESSION_NOT_FOUND, 404),
    };
  }

  if (!chat || chat.sessionId !== sessionId) {
    return {
      ok: false,
      response: toErrorResponse(CHAT_NOT_FOUND, 404),
    };
  }

  return {
    ok: true,
    sessionRecord,
    chat,
  };
}
