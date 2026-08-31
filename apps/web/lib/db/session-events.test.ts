import { describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@paco/agent-backend";
import { sessionEvents } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type Row = { id: number; chatId: string; type: string; payload: unknown };
type Predicate = (row: Row) => boolean;

/**
 * `sessions.test.ts` fakes the whole `./client` module rather than standing
 * up a real Postgres — there is no real-database test anywhere under
 * `lib/db`, and no `POSTGRES_URL` guard to mirror. This does the same: a
 * tiny in-memory store plus real column objects from the schema, so
 * `eq`/`gt`/`and` (mocked below into JS predicates, same trick as
 * `sessions.test.ts`) can filter it the same way Drizzle would filter real rows.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [sessionEvents.chatId, "chatId"],
  [sessionEvents.id, "id"],
  [sessionEvents.type, "type"],
]);

/**
 * What the fake db has handed back to Node since the last `resetReadStats()`,
 * and which columns the WHERE clauses referenced to get there.
 *
 * These exist so a test can assert the *shape of the query* and not just its
 * answer: `listUnconsumedSteerEvents` used to return the right messages while
 * dragging the chat's entire event log — every `assistant/chunk` payload,
 * tool outputs and all — through Postgres and into Node on every 1s poll.
 * A correctness-only test cannot tell the two implementations apart.
 */
let readRows: Row[] = [];
let filteredColumns = new Set<keyof Row>();

function resetReadStats(): void {
  readRows = [];
  filteredColumns = new Set<keyof Row>();
}

function keyFor(column: unknown): keyof Row {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  filteredColumns.add(key);
  return key;
}

const actualDrizzle = await import("drizzle-orm");

type Order = { direction: "asc" | "desc" };

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq: (column: unknown, value: unknown): Predicate => {
    const key = keyFor(column);
    return (row) => row[key] === value;
  },
  gt: (column: unknown, value: unknown): Predicate => {
    const key = keyFor(column);
    return (row) => (row[key] as number) > (value as number);
  },
  gte: (column: unknown, value: unknown): Predicate => {
    const key = keyFor(column);
    return (row) => (row[key] as number) >= (value as number);
  },
  lte: (column: unknown, value: unknown): Predicate => {
    const key = keyFor(column);
    return (row) => (row[key] as number) <= (value as number);
  },
  inArray: (column: unknown, values: unknown[]): Predicate => {
    const key = keyFor(column);
    const allowed = new Set(values);
    return (row) => allowed.has(row[key]);
  },
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  asc: (_column: unknown): Order => ({ direction: "asc" }),
  desc: (_column: unknown): Order => ({ direction: "desc" }),
}));

/** A chat id with no row behind it, so a real FK would reject it. */
const BAD_CHAT_ID = "chat_that_does_not_exist";

let store: Row[] = [];
let nextId = 1;

const fakeDb = {
  insert: (_table: unknown) => ({
    values: async (
      rows: Array<{ chatId: string; type: string; payload: unknown }>,
    ) => {
      if (rows.some((row) => row.chatId === BAD_CHAT_ID)) {
        throw new Error(
          'insert or update on table "session_events" violates foreign key constraint',
        );
      }
      for (const row of rows) {
        store.push({ id: nextId++, ...row });
      }
    },
  }),
  select: (_columns: unknown) => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) => ({
        orderBy: (order?: Order) => {
          const matched = store
            .filter(predicate)
            .sort((a, b) =>
              order?.direction === "desc" ? b.id - a.id : a.id - b.id,
            );

          // Everything past this point crossed the wire: real Postgres would
          // have serialised these rows' `payload` jsonb and Node would have
          // parsed it. Recording them is what lets a test measure the read.
          const rows = () => {
            readRows.push(...matched);
            return matched.map((row) => ({
              id: row.id,
              payload: row.payload,
            }));
          };

          // `latestSessionEventId` chains `.limit(1)`; `listSessionEvents`
          // just awaits the orderBy call directly — a resolved promise with
          // a `limit` method tacked on supports both call shapes. The rows
          // are materialised (and recorded) once, so `.limit(n)` narrows the
          // answer without double-counting the read.
          const selected = rows();
          return Object.assign(Promise.resolve(selected), {
            limit: (n: number) => Promise.resolve(selected.slice(0, n)),
          });
        },
      }),
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  appendSessionEvents,
  appendSessionEventsStrict,
  latestSessionEventId,
  listSessionEvents,
  listTurnSessionEvents,
  listUnconsumedSteerEvents,
} = await import("./session-events");

describe("session events", () => {
  test("append then list round-trips in order", async () => {
    const chatId = "chat-1";
    await appendSessionEvents(chatId, [
      {
        type: "turn/start",
        turnId: "t1",
        messageId: "m1",
        prompt: "hi",
        policy: "steer",
      },
      {
        type: "assistant/chunk",
        turnId: "t1",
        chunk: { type: "text-delta", id: "a", delta: "h" },
      },
      { type: "turn/end", turnId: "t1", finishReason: "stop", isError: false },
    ]);
    const rows = await listSessionEvents(chatId);
    expect(rows.map((r) => r.event.type)).toEqual([
      "turn/start",
      "assistant/chunk",
      "turn/end",
    ]);
    expect(rows[0]!.id).toBeLessThan(rows[2]!.id);
  });

  test("afterId filters", async () => {
    const chatId = "chat-2";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "first" },
    ]);
    const [first] = await listSessionEvents(chatId);
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s2", text: "second" },
    ]);
    const after = await listSessionEvents(chatId, { afterId: first!.id });
    expect(after).toHaveLength(1);
    expect(after[0]!.event.type).toBe("steer/buffered");
  });

  test("unconsumed steer events exclude consumed ones", async () => {
    const chatId = "chat-3";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "one" },
      { type: "steer/buffered", messageId: "s2", text: "two" },
      { type: "steer/consumed", messageId: "s1", mode: "steer" },
    ]);
    const pending = await listUnconsumedSteerEvents(chatId);
    expect(pending.map((p) => p.messageId)).toEqual(["s2"]);
  });

  test("append never throws on a bad chat id", async () => {
    await expect(
      appendSessionEvents(BAD_CHAT_ID, [
        { type: "steer/buffered", messageId: "x", text: "y" },
      ]),
    ).resolves.toBeUndefined();
  });

  test("strict append round-trips like the tolerant variant", async () => {
    const chatId = "chat-4";
    await appendSessionEventsStrict(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "one" },
    ]);
    const rows = await listSessionEvents(chatId);
    expect(rows.map((r) => r.event.type)).toEqual(["steer/buffered"]);
  });

  test("strict append throws on a bad chat id", async () => {
    await expect(
      appendSessionEventsStrict(BAD_CHAT_ID, [
        { type: "steer/buffered", messageId: "x", text: "y" },
      ]),
    ).rejects.toThrow();
  });
});

describe("latestSessionEventId", () => {
  test("returns undefined for a chat with no events", async () => {
    expect(await latestSessionEventId("chat-with-no-events")).toBeUndefined();
  });

  test("returns the highest id recorded for the chat, ignoring other chats", async () => {
    const chatId = "chat-5";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "a", text: "one" },
    ]);
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "b", text: "two" },
    ]);
    await appendSessionEvents("chat-6", [
      { type: "steer/buffered", messageId: "c", text: "three" },
    ]);

    const rows = await listSessionEvents(chatId);
    const expectedLatestId = rows.at(-1)?.id;

    expect(await latestSessionEventId(chatId)).toBe(expectedLatestId);
  });
});

/**
 * A chat's log is dominated by `assistant/chunk` rows: the recorder appends
 * one event per streamed chunk and writes one row per event, so a handful of
 * long turns already puts tens of thousands of rows — many carrying whole
 * tool outputs — behind a single chatId.
 */
function chunkNoise(turnId: string, count: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push({
      type: "assistant/chunk",
      turnId,
      chunk: { type: "text-delta", id: `c${index}`, delta: "x".repeat(64) },
    });
  }
  return events;
}

describe("reads are bounded, not whole-log scans", () => {
  test("listUnconsumedSteerEvents filters by type in SQL instead of in Node", async () => {
    const chatId = "chat-steer-scale";
    await appendSessionEvents(chatId, [
      { type: "steer/buffered", messageId: "s1", text: "one" },
      { type: "steer/buffered", messageId: "s2", text: "two" },
      { type: "steer/consumed", messageId: "s1", mode: "steer" },
    ]);
    await appendSessionEvents(chatId, chunkNoise("t1", 500));

    resetReadStats();
    const pending = await listUnconsumedSteerEvents(chatId);

    // Semantics are unchanged: still the buffered messages nothing consumed.
    expect(pending.map((p) => p.messageId)).toEqual(["s2"]);

    // The steer-poll runs every second for the whole turn, so the query has
    // to be selective in SQL. Filtering on `type` is what the covering index
    // `session_events_chat_id_type_id_idx` needs to be usable at all.
    expect(filteredColumns.has("type")).toBe(true);

    // Nothing outside the steer log may reach Node — no `assistant/chunk`
    // payload, and therefore no tool output, however long the chat gets.
    expect(readRows.map((row) => row.type).sort()).toEqual([
      "steer/buffered",
      "steer/buffered",
      "steer/consumed",
    ]);
  });

  test("listTurnSessionEvents reads one turn's range, not the whole chat", async () => {
    const chatId = "chat-turn-scale";
    await appendSessionEvents(chatId, [
      {
        type: "turn/start",
        turnId: "old",
        messageId: "m-old",
        prompt: "the first turn",
        policy: "steer",
      },
    ]);
    await appendSessionEvents(chatId, chunkNoise("old", 400));
    await appendSessionEvents(chatId, [
      { type: "turn/end", turnId: "old", finishReason: "stop", isError: false },
      {
        type: "turn/start",
        turnId: "target",
        messageId: "m-target",
        prompt: "the turn under distillation",
        policy: "steer",
      },
    ]);
    await appendSessionEvents(chatId, chunkNoise("target", 3));
    await appendSessionEvents(chatId, [
      {
        type: "turn/end",
        turnId: "target",
        finishReason: "stop",
        isError: false,
      },
    ]);
    await appendSessionEvents(chatId, [
      {
        type: "turn/start",
        turnId: "later",
        messageId: "m-later",
        prompt: "a turn after it",
        policy: "steer",
      },
    ]);
    await appendSessionEvents(chatId, chunkNoise("later", 400));

    resetReadStats();
    const slice = await listTurnSessionEvents(chatId, "target");

    expect(slice.map((row) => row.event.type)).toEqual([
      "turn/start",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/chunk",
      "turn/end",
    ]);

    // The 800 chunks belonging to the neighbouring turns are the cost this
    // read used to pay every turn; only the boundary rows and the target
    // turn's own five events may cross the wire now.
    const chunksRead = readRows.filter((row) => row.type === "assistant/chunk");
    expect(chunksRead).toHaveLength(3);
    expect(filteredColumns.has("type")).toBe(true);
  });

  test("listTurnSessionEvents returns nothing for an unknown turn", async () => {
    const chatId = "chat-turn-missing";
    await appendSessionEvents(chatId, chunkNoise("t1", 3));

    expect(await listTurnSessionEvents(chatId, "nope")).toEqual([]);
  });

  test("listTurnSessionEvents reads to the end for an unterminated turn", async () => {
    const chatId = "chat-turn-open";
    await appendSessionEvents(chatId, [
      {
        type: "turn/start",
        turnId: "live",
        messageId: "m-live",
        prompt: "still running",
        policy: "steer",
      },
    ]);
    await appendSessionEvents(chatId, chunkNoise("live", 2));

    const slice = await listTurnSessionEvents(chatId, "live");
    expect(slice.map((row) => row.event.type)).toEqual([
      "turn/start",
      "assistant/chunk",
      "assistant/chunk",
    ]);
  });
});
