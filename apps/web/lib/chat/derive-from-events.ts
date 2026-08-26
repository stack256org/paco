import { chunkOf, type SessionEvent } from "@paco/agent-backend";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

/**
 * Project a turn's assistant message from the event log.
 *
 * Same machinery as the live path in run-step.ts (readUIMessageStream over
 * the chunk sequence, then stamp the caller's message id), which is what
 * makes the replay-equivalence test meaningful: one implementation of
 * "chunks → message", two feeders.
 */
export async function deriveAssistantMessage(
  events: SessionEvent[],
  turnId: string,
  messageId: string,
): Promise<UIMessage | undefined> {
  const chunks: UIMessageChunk[] = [];
  for (const event of events) {
    if (event.type === "assistant/chunk" && event.turnId === turnId) {
      chunks.push(chunkOf(event));
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }

  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) {
    message = m;
  }
  return message ? { ...message, id: messageId } : undefined;
}
