import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@paco/agent-backend";
import { deriveAssistantMessage } from "./derive-from-events";

const turnChunks = [
  { type: "text-start", id: "txt1" },
  { type: "text-delta", id: "txt1", delta: "Hello " },
  { type: "text-delta", id: "txt1", delta: "world" },
  { type: "text-end", id: "txt1" },
];

function eventsFor(turnId: string): SessionEvent[] {
  return [
    {
      type: "turn/start",
      turnId,
      messageId: "m1",
      prompt: "greet",
      policy: "steer",
    },
    { type: "user/message", turnId, messageId: "m1", text: "greet" },
    ...turnChunks.map((chunk) => ({
      type: "assistant/chunk" as const,
      turnId,
      chunk,
    })),
    { type: "turn/end", turnId, finishReason: "stop" as const, isError: false },
  ];
}

describe("deriveAssistantMessage", () => {
  test("replays chunks into the assistant message", async () => {
    const message = await deriveAssistantMessage(
      eventsFor("t1"),
      "t1",
      "msg_9",
    );
    expect(message).toBeDefined();
    expect(message!.id).toBe("msg_9");
    expect(message!.role).toBe("assistant");
    const text = message!.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("ignores other turns' chunks", async () => {
    const mixed = [...eventsFor("t1"), ...eventsFor("t2")];
    const message = await deriveAssistantMessage(mixed, "t2", "msg_2");
    const text = message!.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("returns undefined for a turn with no chunks", async () => {
    const events: SessionEvent[] = [
      {
        type: "turn/start",
        turnId: "t3",
        messageId: "m",
        prompt: "p",
        policy: "steer",
      },
      { type: "turn/end", turnId: "t3", finishReason: "stop", isError: false },
    ];
    expect(await deriveAssistantMessage(events, "t3", "m")).toBeUndefined();
  });

  test("REPLAY EQUIVALENCE: derived message equals the live-path message", async () => {
    // The live path: feed the same chunks through readUIMessageStream the way
    // run-step.ts does, stamp the id, compare deep-equal with the derivation.
    const { readUIMessageStream } = await import("ai");
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of turnChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    let live: unknown;
    for await (const m of readUIMessageStream({ stream })) {
      live = m;
    }
    const liveStamped = { ...(live as { parts: unknown[] }), id: "msg_eq" };
    const derived = await deriveAssistantMessage(
      eventsFor("t1"),
      "t1",
      "msg_eq",
    );
    expect(derived).toEqual(liveStamped as never);
  });
});
