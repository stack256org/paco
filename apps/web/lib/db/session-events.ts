import "server-only";

import { isSessionEvent, type SessionEvent } from "@paco/agent-backend";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sessionEvents } from "@/lib/db/schema";

/**
 * Append events to a chat's log, throwing on insert failure.
 *
 * Use this where the caller must know the write actually landed before
 * promising the client anything durable happened (e.g. buffering a mid-turn
 * message: silently losing that write would strand the message). For
 * additive/best-effort recording, use `appendSessionEvents` instead.
 */
export async function appendSessionEventsStrict(
  chatId: string,
  events: SessionEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await db
    .insert(sessionEvents)
    .values(
      events.map((event) => ({ chatId, type: event.type, payload: event })),
    );
}

/**
 * Append events to a chat's log.
 *
 * Never throws: the log is additive context in Section 1, and a failed append
 * must not fail the turn that produced it (Global Constraints).
 */
export async function appendSessionEvents(
  chatId: string,
  events: SessionEvent[],
): Promise<void> {
  try {
    await appendSessionEventsStrict(chatId, events);
  } catch (error) {
    console.error("session-events: append failed", {
      chatId,
      count: events.length,
      error,
    });
  }
}

/**
 * The event types that make up the steer protocol.
 *
 * Kept as a `type`-column filter rather than a payload filter on purpose:
 * `type` is a real column (written from `event.type` on insert), so a
 * `chat_id = ? AND type IN (…)` predicate is index-backed by
 * `session_events_chat_id_type_id_idx` and never touches the jsonb.
 */
const STEER_EVENT_TYPES = ["steer/buffered", "steer/consumed"] as const;

/** The two events that delimit a turn's slice of the log. */
const TURN_BOUNDARY_TYPES = ["turn/start", "turn/end"] as const;

/**
 * Run one bounded `session_events` read and narrow the rows to real events.
 *
 * Every read in this module goes through here so that no caller can
 * accidentally reintroduce an unbounded `WHERE chat_id = ?` scan: the
 * `where` it is handed is the *whole* predicate Postgres will apply, and
 * anything a caller filters afterwards in JS is filtering rows it has
 * already paid to transfer and parse.
 */
async function selectEvents(
  where: SQL | undefined,
): Promise<Array<{ id: number; event: SessionEvent }>> {
  const rows = await db
    .select({ id: sessionEvents.id, payload: sessionEvents.payload })
    .from(sessionEvents)
    .where(where)
    .orderBy(asc(sessionEvents.id));

  const result: Array<{ id: number; event: SessionEvent }> = [];
  for (const row of rows) {
    if (isSessionEvent(row.payload)) {
      result.push({ id: row.id, event: row.payload });
    }
  }
  return result;
}

export async function listSessionEvents(
  chatId: string,
  opts?: { afterId?: number },
): Promise<Array<{ id: number; event: SessionEvent }>> {
  return await selectEvents(
    opts?.afterId !== undefined
      ? and(
          eq(sessionEvents.chatId, chatId),
          gt(sessionEvents.id, opts.afterId),
        )
      : eq(sessionEvents.chatId, chatId),
  );
}

/**
 * Buffered steer messages not yet consumed by a turn.
 *
 * Hot path: the steer monitor in `app/workflows/chat.ts` polls this once a
 * second for the entire duration of every turn under the `"steer"` policy,
 * and the continuation loop calls it again per continuation. It used to read
 * the chat's *whole* log and pick the steer events out in JS — which meant a
 * chat with a few long turns behind it re-read tens of thousands of
 * `assistant/chunk` rows, tool outputs and all, every second, against a log
 * that was still growing underneath the poll.
 *
 * The type filter now happens in SQL, so the read is proportional to the
 * chat's steer traffic (a handful of rows, no jsonb of consequence) instead
 * of its history. Only the buffered/consumed pairing is still resolved in
 * JS: `messageId` lives inside the jsonb payload, so matching it in SQL
 * would need an expression index to be worth anything, and the row set it
 * would narrow is already tiny.
 */
export async function listUnconsumedSteerEvents(
  chatId: string,
): Promise<Array<{ id: number; messageId: string; text: string }>> {
  const rows = await selectEvents(
    and(
      eq(sessionEvents.chatId, chatId),
      inArray(sessionEvents.type, [...STEER_EVENT_TYPES]),
    ),
  );

  const consumed = new Set<string>();
  for (const { event } of rows) {
    if (event.type === "steer/consumed") {
      consumed.add(event.messageId);
    }
  }
  const pending: Array<{ id: number; messageId: string; text: string }> = [];
  for (const { id, event } of rows) {
    if (event.type === "steer/buffered" && !consumed.has(event.messageId)) {
      pending.push({ id, messageId: event.messageId, text: event.text });
    }
  }
  return pending;
}

/**
 * One turn's slice of a chat's log, in insertion order.
 *
 * A turn's events are contiguous in `id`: a chat has a single writer (the
 * active-stream claim), so everything recorded between the turn's
 * `turn/start` and its `turn/end` belongs to that turn, bar the occasional
 * chat-scoped event (a `steer/buffered` arriving mid-turn, a `task/status`)
 * that callers already ignore. That makes the slice a plain `id` range,
 * which the existing `session_events_chat_id_id_idx` serves directly —
 * rather than a full-history read that a per-turn caller then filters by
 * `turnId` in JS.
 *
 * Locating the range costs one type-filtered read of the chat's turn
 * boundaries (two small rows per turn, no chunk payloads); if turn counts
 * ever grow enough for that to matter, an expression index on
 * `payload->>'turnId'` would collapse it to the two rows that match.
 *
 * Returns `[]` when the chat has no `turn/start` for `turnId`. An
 * unterminated turn (no `turn/end` yet) reads to the end of the log.
 */
export async function listTurnSessionEvents(
  chatId: string,
  turnId: string,
): Promise<Array<{ id: number; event: SessionEvent }>> {
  const boundaries = await selectEvents(
    and(
      eq(sessionEvents.chatId, chatId),
      inArray(sessionEvents.type, [...TURN_BOUNDARY_TYPES]),
    ),
  );

  let startId: number | undefined;
  let endId: number | undefined;
  for (const { id, event } of boundaries) {
    if (event.type === "turn/start" && event.turnId === turnId) {
      startId = id;
      endId = undefined;
    } else if (
      event.type === "turn/end" &&
      event.turnId === turnId &&
      startId !== undefined &&
      endId === undefined
    ) {
      endId = id;
    }
  }

  if (startId === undefined) {
    return [];
  }

  const bounds = [
    eq(sessionEvents.chatId, chatId),
    gte(sessionEvents.id, startId),
  ];
  if (endId !== undefined) {
    bounds.push(lte(sessionEvents.id, endId));
  }
  return await selectEvents(and(...bounds));
}

/**
 * The highest event id currently recorded for a chat, or `undefined` if it
 * has none yet.
 *
 * Backs the plugin event fan-out's (`lib/plugins/event-fanout.ts`) cursor
 * seeding: a plugin subscribing to a chat should see new events from the
 * moment it subscribes, not the chat's entire history, so the fan-out seeds
 * a fresh cursor to this value instead of leaving it `undefined` (which
 * `listSessionEvents` treats as "from the beginning").
 */
export async function latestSessionEventId(
  chatId: string,
): Promise<number | undefined> {
  const rows = await db
    .select({ id: sessionEvents.id })
    .from(sessionEvents)
    .where(eq(sessionEvents.chatId, chatId))
    .orderBy(desc(sessionEvents.id))
    .limit(1);

  return rows[0]?.id;
}
