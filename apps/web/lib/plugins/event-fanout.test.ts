import { describe, expect, mock, test } from "bun:test";
import type { PluginHost } from "@paco/plugin-host";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type EventRow = { id: number; chatId: string; event: unknown };

let store: EventRow[] = [];
let nextId = 1;
let listSessionEventsCalls: Array<{
  chatId: string;
  afterId: number | undefined;
}> = [];

function pushEvent(chatId: string, event: unknown): void {
  store.push({ id: nextId++, chatId, event });
}

const listSessionEventsSpy = mock(
  async (chatId: string, opts?: { afterId?: number }) => {
    listSessionEventsCalls.push({ chatId, afterId: opts?.afterId });
    return store
      .filter(
        (row) =>
          row.chatId === chatId &&
          (opts?.afterId === undefined || row.id > opts.afterId),
      )
      .sort((a, b) => a.id - b.id)
      .map((row) => ({ id: row.id, event: row.event }));
  },
);

mock.module("@/lib/db/session-events", () => ({
  listSessionEvents: listSessionEventsSpy,
}));

const { SessionEventFanout } = await import("./event-fanout");

function fakeHost(): PluginHost & { deliverEvent: ReturnType<typeof mock> } {
  return {
    deliverEvent: mock((_id: number, _chatId: string, _event: unknown) => {
      // no-op recorder
    }),
  } as unknown as PluginHost & { deliverEvent: ReturnType<typeof mock> };
}

describe("SessionEventFanout", () => {
  test("delivers new events to a registered host and advances its cursor", async () => {
    store = [];
    nextId = 1;
    listSessionEventsCalls = [];
    pushEvent("chat-1", { type: "turn/start", turnId: "t1" });

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host, ["chat-1"]);

    await fanout.poll();

    expect(host.deliverEvent).toHaveBeenCalledTimes(1);
    expect(host.deliverEvent).toHaveBeenCalledWith(1, "chat-1", {
      type: "turn/start",
      turnId: "t1",
    });

    // A second poll with no new rows must not re-deliver the first event —
    // the cursor advanced past it.
    await fanout.poll();
    expect(host.deliverEvent).toHaveBeenCalledTimes(1);

    pushEvent("chat-1", { type: "turn/end", turnId: "t1" });
    await fanout.poll();
    expect(host.deliverEvent).toHaveBeenCalledTimes(2);
    expect(host.deliverEvent).toHaveBeenLastCalledWith(2, "chat-1", {
      type: "turn/end",
      turnId: "t1",
    });

    const cursorCalls = listSessionEventsCalls.filter(
      (call) => call.chatId === "chat-1",
    );
    expect(cursorCalls[0]?.afterId).toBeUndefined();
    expect(cursorCalls[1]?.afterId).toBe(1);
    expect(cursorCalls[2]?.afterId).toBe(1);
  });

  test("two hosts with different chat filters only see their own chat's events", async () => {
    store = [];
    nextId = 1;
    pushEvent("chat-a", { type: "turn/start", turnId: "ta" });
    pushEvent("chat-b", { type: "turn/start", turnId: "tb" });

    const fanout = new SessionEventFanout(1000);
    const hostA = fakeHost();
    const hostB = fakeHost();
    fanout.register(hostA, ["chat-a"]);
    fanout.register(hostB, ["chat-b"]);

    await fanout.poll();

    expect(hostA.deliverEvent).toHaveBeenCalledTimes(1);
    expect(hostA.deliverEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "chat-a",
      { type: "turn/start", turnId: "ta" },
    );
    expect(hostB.deliverEvent).toHaveBeenCalledTimes(1);
    expect(hostB.deliverEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "chat-b",
      { type: "turn/start", turnId: "tb" },
    );
  });

  test("a host without a chat filter receives events for every chat another registration tracks", async () => {
    store = [];
    nextId = 1;
    pushEvent("chat-a", { type: "turn/start", turnId: "ta" });

    const fanout = new SessionEventFanout(1000);
    const trackedHost = fakeHost();
    const untrackedHost = fakeHost();
    fanout.register(trackedHost, ["chat-a"]);
    fanout.register(untrackedHost);

    await fanout.poll();

    expect(untrackedHost.deliverEvent).toHaveBeenCalledTimes(1);
    expect(untrackedHost.deliverEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "chat-a",
      { type: "turn/start", turnId: "ta" },
    );
  });

  test("unregister stops a host from receiving further events", async () => {
    store = [];
    nextId = 1;
    pushEvent("chat-1", { type: "turn/start", turnId: "t1" });

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host, ["chat-1"]);
    await fanout.poll();
    expect(host.deliverEvent).toHaveBeenCalledTimes(1);

    fanout.unregister(host);
    pushEvent("chat-1", { type: "turn/end", turnId: "t1" });
    await fanout.poll();

    expect(host.deliverEvent).toHaveBeenCalledTimes(1);
  });

  test("start schedules a repeating poll and stop clears its timer", async () => {
    const setIntervalSpy = mock(globalThis.setInterval);
    const clearIntervalSpy = mock(globalThis.clearInterval);
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = setIntervalSpy as unknown as typeof setInterval;
    globalThis.clearInterval =
      clearIntervalSpy as unknown as typeof clearInterval;

    try {
      const fanout = new SessionEventFanout(500);

      fanout.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(500);

      // Calling start() again while already running must not schedule a
      // second timer.
      fanout.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      fanout.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      // stop() again is a no-op — there is no timer left to clear.
      fanout.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
