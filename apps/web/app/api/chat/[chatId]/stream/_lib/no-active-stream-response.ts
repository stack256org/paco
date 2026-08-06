import { createUIMessageStreamResponse } from "ai";

/**
 * The answer this endpoint gives when there is nothing to resume.
 *
 * It cannot be `204 No Content`, which is what it used to be. The client's
 * `WorkflowChatTransport` resumes inside `while (!gotFinish)`, and it only
 * leaves that loop when it reads a `finish` chunk. Its guard against a bad
 * response is `if (!res.ok || !res.body) throw` — but a 204 is 2xx, so
 * `res.ok` is true, and Chrome hands back an empty `ReadableStream` rather
 * than `null`, so `res.body` is truthy too. The empty body then parses as a
 * stream of zero chunks, which is not an error, so the loop simply fetches
 * again — with no delay, forever.
 *
 * Measured against the running dev server, that was ~50 requests a second per
 * open tab, indefinitely: the "failed to fetch" banners, the UI insisting the
 * agent was still working after Stop, the dev server compiling on a loop, and
 * the server heap climbing past 1.8 GB were all this one loop.
 *
 * A single `finish` chunk ends it. The chunk is deliberately bare: the AI SDK
 * only writes a message to state when a chunk carries `messageId` or
 * `messageMetadata`, so a `finish` with neither terminates the stream and
 * settles the status to `ready` without leaving a phantom empty message
 * behind.
 */
export function createNoActiveStreamResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "finish" as const });
      controller.close();
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      // Lets a client (and anyone reading a HAR) tell "nothing is running"
      // apart from "here is the tail of a real stream".
      "x-paco-stream-inactive": "1",
    },
  });
}
