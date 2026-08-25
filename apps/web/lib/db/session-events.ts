import "server-only";

import { isSessionEvent, type SessionEvent } from "@paco/agent-backend";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { sessionEvents } from "@/lib/db/schema";

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
  if (events.length === 0) {
    return;
  }
  try {
    await db
      .insert(sessionEvents)
      .values(
        events.map((event) => ({ chatId, type: event.type, payload: event })),
      );
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
