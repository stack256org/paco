import { beforeEach, describe, expect, mock, test } from "bun:test";
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

function pushEvent(chatId: string, event: unknown): number {
  const id = nextId++;
  store.push({ id, chatId, event });
  return id;
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

const latestSessionEventIdSpy = mock(async (chatId: string) => {
  const rows = store
    .filter((row) => row.chatId === chatId)
    .sort((a, b) => a.id - b.id);
  return rows.at(-1)?.id;
});

mock.module("@/lib/db/session-events", () => ({
  latestSessionEventId: latestSessionEventIdSpy,
  listSessionEvents: listSessionEventsSpy,
}));

let activeChatIds: string[] = [];
const listActiveChatIdsSpy = mock(async () => activeChatIds);

mock.module("@/lib/db/sessions", () => ({
  listActiveChatIds: listActiveChatIdsSpy,
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
  beforeEach(() => {
    listSessionEventsSpy.mockClear();
    latestSessionEventIdSpy.mockClear();
    listActiveChatIdsSpy.mockClear();
  });

  test("a newly registered host does not replay a chat's prior history", async () => {
    store = [];
    nextId = 1;
    listSessionEventsCalls = [];
    pushEvent("chat-1", { type: "turn/start", turnId: "t1" }); // pre-existing, before registration

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host, ["chat-1"]);

    // First poll only seeds the cursor to "now" — nothing delivered, and
    // it doesn't even need to query listSessionEvents to know that.
    await fanout.poll();
    expect(host.deliverEvent).not.toHaveBeenCalled();
    expect(listSessionEventsSpy).not.toHaveBeenCalled();
    expect(latestSessionEventIdSpy).toHaveBeenCalledWith("chat-1");

    // A genuinely new event, landing after registration, is delivered.
    pushEvent("chat-1", { type: "turn/end", turnId: "t1" });
    await fanout.poll();
    expect(host.deliverEvent).toHaveBeenCalledTimes(1);
    expect(host.deliverEvent).toHaveBeenCalledWith(2, "chat-1", {
      type: "turn/end",
      turnId: "t1",
    });

    // A third poll with no new rows must not re-deliver anything.
    await fanout.poll();
    expect(host.deliverEvent).toHaveBeenCalledTimes(1);

    const cursorCalls = listSessionEventsCalls.filter(
      (call) => call.chatId === "chat-1",
    );
    expect(cursorCalls[0]?.afterId).toBe(1);
    expect(cursorCalls[1]?.afterId).toBe(2);
  });

  test("an explicit sinceId replays from that id on the first poll", async () => {
    store = [];
    nextId = 1;
    pushEvent("chat-1", { type: "turn/start", turnId: "t1" });
    pushEvent("chat-1", { type: "turn/end", turnId: "t1" });

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host, ["chat-1"], { sinceId: 0 });

    await fanout.poll();

    expect(host.deliverEvent).toHaveBeenCalledTimes(2);
    expect(host.deliverEvent).toHaveBeenNthCalledWith(1, 1, "chat-1", {
      type: "turn/start",
      turnId: "t1",
    });
    expect(host.deliverEvent).toHaveBeenNthCalledWith(2, 2, "chat-1", {
      type: "turn/end",
      turnId: "t1",
    });
    // A sinceId replay never needs to ask for "the latest id" — the caller
    // already named the starting point.
    expect(latestSessionEventIdSpy).not.toHaveBeenCalled();
  });

  test("two hosts with different chat filters only see their own chat's events", async () => {
    store = [];
    nextId = 1;

    const fanout = new SessionEventFanout(1000);
    const hostA = fakeHost();
    const hostB = fakeHost();
    fanout.register(hostA, ["chat-a"]);
    fanout.register(hostB, ["chat-b"]);
    await fanout.poll(); // seed both

    pushEvent("chat-a", { type: "turn/start", turnId: "ta" });
    pushEvent("chat-b", { type: "turn/start", turnId: "tb" });
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

  test("a host without a chat filter receives events from every active chat", async () => {
    store = [];
    nextId = 1;
    activeChatIds = ["chat-a", "chat-b"];

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host); // no chatFilter
    await fanout.poll(); // seed

    pushEvent("chat-a", { type: "turn/start", turnId: "ta" });
    pushEvent("chat-b", { type: "turn/start", turnId: "tb" });
    await fanout.poll();

    expect(host.deliverEvent).toHaveBeenCalledTimes(2);
    expect(listActiveChatIdsSpy).toHaveBeenCalled();

    activeChatIds = [];
  });

  test("a chat whose session is archived is excluded from the no-filter contract", async () => {
    store = [];
    nextId = 1;
    // `listActiveChatIds` (lib/db/sessions.ts) is the source of truth for
    // "active" — an archived session's chat simply never appears in its
    // result, so the fan-out never even considers it.
    activeChatIds = ["chat-live"];

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host);
    await fanout.poll(); // seed

    pushEvent("chat-live", { type: "turn/start", turnId: "live" });
    pushEvent("chat-archived", { type: "turn/start", turnId: "archived" });
    await fanout.poll();

    expect(host.deliverEvent).toHaveBeenCalledTimes(1);
    expect(host.deliverEvent).toHaveBeenCalledWith(
      expect.any(Number),
      "chat-live",
      { type: "turn/start", turnId: "live" },
    );

    activeChatIds = [];
  });

  test("unregister stops a host from receiving further events", async () => {
    store = [];
    nextId = 1;

    const fanout = new SessionEventFanout(1000);
    const host = fakeHost();
    fanout.register(host, ["chat-1"]);
    await fanout.poll(); // seed

    pushEvent("chat-1", { type: "turn/start", turnId: "t1" });
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
