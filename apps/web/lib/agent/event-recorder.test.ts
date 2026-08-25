import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@paco/agent-backend";

// The default appender pulls in @/lib/db/session-events, which is
// server-only; every test here injects its own fake appender instead, so
// the marker package just needs to not throw at import time. Dynamic import
// (matching session-events.test.ts) so this registration lands before
// "./event-recorder" is evaluated -- a static import would be hoisted ahead
// of it.
mock.module("server-only", () => ({}));
const { TurnEventRecorder } = await import("./event-recorder");

function collectingAppender() {
  const batches: SessionEvent[][] = [];
  const append = mock((_chatId: string, events: SessionEvent[]) => {
    batches.push(events);
    return Promise.resolve();
  });
  return { batches, append };
}

describe("TurnEventRecorder", () => {
  test("start logs turn/start and user/message; assertPromptLogged passes", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "hello", policy: "steer" });
    expect(batches[0]!.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
    ]);
    expect(() => recorder.assertPromptLogged("hello")).not.toThrow();
    expect(() => recorder.assertPromptLogged("other")).toThrow(/invariant/i);
  });

  test("chunks flush in batches of 50 and on finish", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "p", policy: "steer" });
    for (let i = 0; i < 120; i++) {
      recorder.chunk({ type: "text-delta", id: "t", delta: String(i) });
    }
    await recorder.finish({ finishReason: "stop", isError: false });
    // start batch + two full chunk batches + final batch (20 chunks + turn/end)
    const chunkEvents = batches
      .flat()
      .filter((e) => e.type === "assistant/chunk");
    expect(chunkEvents).toHaveLength(120);
    const last = batches.at(-1)!;
    expect(last.at(-1)!.type).toBe("turn/end");
  });

  test("finish with usage logs usage/reported before turn/end", async () => {
    const { batches, append } = collectingAppender();
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    await recorder.start({ messageId: "m1", prompt: "p", policy: "queue" });
    await recorder.finish({
      finishReason: "stop",
      isError: false,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        models: {},
      },
      costUsd: 0.01,
      steered: { text: "go left" },
    });
    const types = batches.flat().map((e) => e.type);
    expect(types.indexOf("usage/reported")).toBeLessThan(
      types.indexOf("turn/end"),
    );
    const end = batches.flat().find((e) => e.type === "turn/end");
    expect(end).toMatchObject({ steered: { text: "go left" } });
  });
  test("chunk appends serialize before finish, even when the first append is slow", async () => {
    const completionOrder: string[] = [];
    let calls = 0;
    const append = mock((_chatId: string, _events: SessionEvent[]) => {
      const callNumber = calls;
      calls += 1;
      return new Promise<void>((resolve) => {
        const delay = callNumber === 0 ? 30 : 0;
        setTimeout(() => {
          completionOrder.push(callNumber === 0 ? "chunks" : "finish");
          resolve();
        }, delay);
      });
    });
    const recorder = new TurnEventRecorder("chat1", "turn1", append);
    for (let i = 0; i < 50; i++) {
      recorder.chunk({ type: "text-delta", id: "t", delta: String(i) });
    }
    // The 50th chunk triggers the flush: that's append call 0, delayed 30ms.
    const finishPromise = recorder.finish({
      finishReason: "stop",
      isError: false,
    });
    let finishResolved = false;
    void finishPromise.then(() => {
      finishResolved = true;
    });

    // Before the delayed chunk batch settles, finish's own (immediate) append
    // must not have completed yet -- it is chained behind the chunk batch.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(finishResolved).toBe(false);

    await finishPromise;
    expect(finishResolved).toBe(true);
    expect(completionOrder).toEqual(["chunks", "finish"]);
  });

  test("a rejecting appender does not surface as an unhandled rejection and finish still resolves", async () => {
    const append = mock((_chatId: string, _events: SessionEvent[]) =>
      Promise.reject(new Error("boom")),
    );
    const originalConsoleError = console.error;
    const consoleErrorSpy = mock(() => undefined);
    console.error = consoleErrorSpy;
    try {
      const recorder = new TurnEventRecorder("chat1", "turn1", append);
      await expect(
        recorder.start({ messageId: "m1", prompt: "p", policy: "steer" }),
      ).resolves.toBeUndefined();
      await expect(
        recorder.finish({ finishReason: "stop", isError: false }),
      ).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
