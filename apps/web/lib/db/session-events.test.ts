import { describe, expect, mock, test } from "bun:test";
import { sessionEvents } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type Row = { id: number; chatId: string; type: string; payload: unknown };
type Predicate = (row: Row) => boolean;

/**
 * `sessions.test.ts` and `users.test.ts` fake the whole `./client` module
 * rather than standing up a real Postgres — there is no real-database test
 * anywhere under `lib/db`, and no `POSTGRES_URL` guard to mirror. This does
 * the same: a tiny in-memory store plus real column objects from the schema,
 * so `eq`/`gt`/`and` (mocked below into JS predicates, same trick as
 * `users.test.ts`) can filter it the same way Drizzle would filter real rows.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [sessionEvents.chatId, "chatId"],
  [sessionEvents.id, "id"],
]);

function keyFor(column: unknown): keyof Row {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

const actualDrizzle = await import("drizzle-orm");

type Order = { direction: "asc" | "desc" };

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  gt:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      (row[keyFor(column)] as number) > (value as number),
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
          const rows = () =>
            store
              .filter(predicate)
              .sort((a, b) =>
                order?.direction === "desc" ? b.id - a.id : a.id - b.id,
              )
              .map((row) => ({ id: row.id, payload: row.payload }));

          // `latestSessionEventId` chains `.limit(1)`; `listSessionEvents`
          // just awaits the orderBy call directly — a resolved promise with
          // a `limit` method tacked on supports both call shapes.
          return Object.assign(Promise.resolve(rows()), {
            limit: (n: number) => Promise.resolve(rows().slice(0, n)),
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
