import "server-only";

import type { PluginHost } from "@paco/plugin-host";
import { listActiveChatIds } from "@/lib/db/sessions";
import {
  latestSessionEventId,
  listSessionEvents,
} from "@/lib/db/session-events";

const DEFAULT_POLL_MS = 1000;

export interface RegisterOptions {
  /**
   * Replay events from after this id instead of seeding at "now". Absent —
   * the default — means a newly registered host sees only events that land
   * after it subscribes, never the chat's prior history.
   */
  sinceId?: number;
}

interface Registration {
  /**
   * `undefined` is the documented "all active chats" contract: such a host
   * is polled against every chat `listActiveChatIds` currently reports (its
   * owning session not archived), re-resolved on every tick, unioned with
   * whatever explicit filters other registrations name. There is no cached
   * snapshot — a chat's session getting archived mid-run drops it on the
   * very next tick.
   */
  chatFilter: Set<string> | undefined;
  sinceId: number | undefined;
}

/**
 * Fans session events out to subscribed plugin hosts.
 *
 * Polling `listSessionEvents` per chat, on a timer, is the deliberate
 * choice (spec Section 2 Task 6): Section 1's steer monitor
 * (`app/workflows/chat.ts`) already polls the same table on the same kind of
 * cadence to notice a buffered message, so this keeps one consistency story
 * — "how does anything in Paco learn about a new session event" — instead of
 * introducing LISTEN/NOTIFY as a second one. That is a later optimization,
 * not this plan.
 *
 * Cursors are per `(host, chatId)` pair, not per chat: two hosts watching
 * the same chat must not be forced onto one shared position, since one can
 * register (and so start "now") long after the other. The first time a
 * given host is polled against a given chat, its cursor is seeded rather
 * than left at "the beginning" — to `sinceId` if the registration asked for
 * a specific replay point, otherwise to `latestSessionEventId(chatId)`, so
 * that seeding tick delivers nothing and only events landing afterward do.
 */
export class SessionEventFanout {
  private readonly pollMs: number;
  private readonly registrations = new Map<PluginHost, Registration>();
  private readonly cursors = new Map<PluginHost, Map<string, number>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(pollMs: number = DEFAULT_POLL_MS) {
    this.pollMs = pollMs;
  }

  register(
    host: PluginHost,
    chatFilter?: string[],
    options?: RegisterOptions,
  ): void {
    this.registrations.set(host, {
      chatFilter: chatFilter ? new Set(chatFilter) : undefined,
      sinceId: options?.sinceId,
    });
    this.cursors.set(host, new Map());
  }

  unregister(host: PluginHost): void {
    this.registrations.delete(host);
    this.cursors.delete(host);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
  }

  /** Clears the poll timer. Registrations survive — `start()` resumes them. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Runs one poll cycle. Exposed so tests can drive a cycle deterministically
   * instead of racing a real timer.
   *
   * `listActiveChatIds` is queried at most once per cycle — only when some
   * registration actually has no `chatFilter` — and shared by every such
   * registration in this tick, rather than once per host.
   */
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const needsActiveChats = [...this.registrations.values()].some(
        (registration) => !registration.chatFilter,
      );
      const activeChatIds = needsActiveChats
        ? await this.loadActiveChatIds()
        : [];

      for (const [host, registration] of this.registrations) {
        const chatIds = registration.chatFilter
          ? [...registration.chatFilter]
          : activeChatIds;
        for (const chatId of chatIds) {
          await this.pollHostChat(host, registration, chatId);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async loadActiveChatIds(): Promise<string[]> {
    try {
      return await listActiveChatIds();
    } catch (error) {
      console.error("plugin event fan-out: failed to list active chats", {
        error,
      });
      return [];
    }
  }

  private async pollHostChat(
    host: PluginHost,
    registration: Registration,
    chatId: string,
  ): Promise<void> {
    let hostCursors = this.cursors.get(host);
    if (!hostCursors) {
      hostCursors = new Map();
      this.cursors.set(host, hostCursors);
    }

    let afterId = hostCursors.get(chatId);
    if (afterId === undefined) {
      const seeded = await this.seedCursor(registration, chatId);
      if (!seeded) {
        return;
      }
      hostCursors.set(chatId, seeded.afterId);
      if (!seeded.replay) {
        // Seeded to "now" — by definition nothing exists past this cursor
        // yet, so there is nothing to fetch on this same tick.
        return;
      }
      afterId = seeded.afterId;
    }

    let rows: Array<{ id: number; event: unknown }>;
    try {
      rows = await listSessionEvents(chatId, { afterId });
    } catch (error) {
      console.error("plugin event fan-out: failed to list session events", {
        chatId,
        error,
      });
      return;
    }

    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      host.deliverEvent(row.id, chatId, row.event);
    }

    const lastRow = rows.at(-1);
    if (lastRow) {
      hostCursors.set(chatId, lastRow.id);
    }
  }

  private async seedCursor(
    registration: Registration,
    chatId: string,
  ): Promise<{ afterId: number; replay: boolean } | undefined> {
    if (registration.sinceId !== undefined) {
      return { afterId: registration.sinceId, replay: true };
    }

    try {
      const latest = await latestSessionEventId(chatId);
      return { afterId: latest ?? 0, replay: false };
    } catch (error) {
      console.error("plugin event fan-out: failed to seed cursor", {
        chatId,
        error,
      });
      // Leave this host/chat pair unseeded rather than guessing: returning
      // `undefined` retries seeding next tick instead of either replaying
      // the whole chat or silently orphaning it on one transient error.
      return undefined;
    }
  }
}
