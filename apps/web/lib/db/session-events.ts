import "server-only";

import { isSessionEvent, type SessionEvent } from "@paco/agent-backend";
import { and, asc, desc, eq, gt } from "drizzle-orm";
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

export async function listSessionEvents(
  chatId: string,
  opts?: { afterId?: number },
): Promise<Array<{ id: number; event: SessionEvent }>> {
  const where =
    opts?.afterId !== undefined
      ? and(
          eq(sessionEvents.chatId, chatId),
          gt(sessionEvents.id, opts.afterId),
        )
      : eq(sessionEvents.chatId, chatId);

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

/** Buffered steer messages not yet consumed by a turn. */
export async function listUnconsumedSteerEvents(
  chatId: string,
): Promise<Array<{ id: number; messageId: string; text: string }>> {
  const rows = await listSessionEvents(chatId);
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
