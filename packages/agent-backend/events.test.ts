import { describe, expect, test } from "bun:test";
import { isSessionEvent, sessionEventSchema, zeroUsage } from "./events.ts";

describe("sessionEventSchema", () => {
  test("accepts a turn/start event", () => {
    const event = {
      type: "turn/start" as const,
      turnId: "turn_1",
      messageId: "msg_1",
      prompt: "build a widget",
      policy: "steer" as const,
    };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  test("accepts an assistant/chunk event with an arbitrary chunk", () => {
    const event = {
      type: "assistant/chunk" as const,
      turnId: "turn_1",
      chunk: { type: "text-delta", id: "t1", delta: "hi" },
    };
    expect(sessionEventSchema.parse(event).type).toBe("assistant/chunk");
  });

  test("accepts turn/end with usage and steered payloads", () => {
    const event = {
      type: "turn/end" as const,
      turnId: "turn_1",
      finishReason: "stop" as const,
      isError: false,
      steered: { text: "actually, use pnpm" },
    };
    expect(sessionEventSchema.parse(event)).toEqual(event);
  });

  test("rejects an unknown type", () => {
    expect(() => sessionEventSchema.parse({ type: "bogus/none" })).toThrow();
  });

  test("isSessionEvent narrows", () => {
    expect(
      isSessionEvent({
        type: "steer/buffered" as const,
        messageId: "m",
        text: "x",
      }),
    ).toBe(true);
    expect(isSessionEvent({ type: "nope" })).toBe(false);
    expect(isSessionEvent(null)).toBe(false);
  });
});

describe("zeroUsage", () => {
  test("is all zeros with empty models", () => {
    expect(zeroUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    });
  });
});
