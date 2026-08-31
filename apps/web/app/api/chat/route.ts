import { createUIMessageStreamResponse } from "ai";
import { submitChatMessage } from "@/lib/chat/submit-message";
import { requireOwnedSessionChat } from "./_lib/chat-context";
import { parseChatRequestBody, requireChatIdentifiers } from "./_lib/request";

const STILL_WORKING =
  "Paco is still working on your last message. Wait for it to finish, or press Stop.";

const STEER_BUFFER_FAILED = "Couldn't save your message. Try sending it again.";

export async function POST(req: Request) {
  const parsedBody = await parseChatRequestBody(req);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const { messages } = parsedBody.body;

  // Require sessionId and chatId to ensure sandbox ownership verification
  const chatIdentifiers = requireChatIdentifiers(parsedBody.body);
  if (!chatIdentifiers.ok) {
    return chatIdentifiers.response;
  }
  const { sessionId, chatId } = chatIdentifiers;

  const chatContext = await requireOwnedSessionChat({ sessionId, chatId });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const { sessionRecord, chat } = chatContext;

  const outcome = await submitChatMessage({
    chatId,
    sessionId,
    userId: sessionRecord.userId,
    messages,
    requestUrl: req.url,
    sessionStatus: sessionRecord.status,
    activeStreamId: chat.activeStreamId,
  });

  switch (outcome.kind) {
    case "archived":
      return Response.json(
        {
          error:
            "This session is archived. Unarchive it before sending a message.",
        },
        { status: 400 },
      );
    case "buffer-failed":
      return Response.json({ error: STEER_BUFFER_FAILED }, { status: 503 });
    case "conflict":
      return Response.json({ error: STILL_WORKING }, { status: 409 });
    case "streaming":
      return createUIMessageStreamResponse({
        stream: outcome.stream,
        headers: {
          "x-workflow-run-id": outcome.runId,
        },
      });
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled submitChatMessage outcome: ${exhaustive}`);
    }
  }
}
