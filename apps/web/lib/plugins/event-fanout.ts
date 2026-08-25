import "server-only";

import type { PluginHost } from "@paco/plugin-host";
import { listSessionEvents } from "@/lib/db/session-events";

const DEFAULT_POLL_MS = 1000;

interface Registration {
  /**
   * `undefined` means "no chat list of its own" — such a host still only
   * ever sees chats some other registration named, it just isn't filtered
   * out of any of them. There is no global "every chat" listing here.
   */
  chatFilter: Set<string> | undefined;
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
 * Each chat gets its own `afterId` cursor, advanced only past rows that were
 * actually handed to `listSessionEvents` (so a failed poll retries the same
 * rows next tick instead of silently skipping them), and a plugin only ever
 * receives events for chats its own registration's `chatFilter` names — the
 * fan-out itself has no notion of "every chat in the instance".
 */
export class SessionEventFanout {
  private readonly pollMs: number;
  private readonly registrations = new Map<PluginHost, Registration>();
  private readonly cursors = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(pollMs: number = DEFAULT_POLL_MS) {
    this.pollMs = pollMs;
  }

  register(host: PluginHost, chatFilter?: string[]): void {
    this.registrations.set(host, {
      chatFilter: chatFilter ? new Set(chatFilter) : undefined,
    });
  }

  unregister(host: PluginHost): void {
    this.registrations.delete(host);
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
   * Runs one poll cycle: every chat named by some registration's
   * `chatFilter` is fetched once and delivered to every registration whose
   * filter includes it (or that has no filter of its own). Exposed so tests
   * can drive a cycle deterministically instead of racing a real timer.
   */
  async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      for (const chatId of this.trackedChatIds()) {
        await this.pollChat(chatId);
      }
    } finally {
      this.polling = false;
    }
  }

  private trackedChatIds(): Set<string> {
    const chatIds = new Set<string>();
    for (const registration of this.registrations.values()) {
      if (!registration.chatFilter) {
        continue;
      }
      for (const chatId of registration.chatFilter) {
        chatIds.add(chatId);
      }
    }
    return chatIds;
  }

  private async pollChat(chatId: string): Promise<void> {
    const afterId = this.cursors.get(chatId);
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
      for (const [host, registration] of this.registrations) {
        if (registration.chatFilter && !registration.chatFilter.has(chatId)) {
          continue;
        }
        host.deliverEvent(row.id, chatId, row.event);
      }
    }

    const lastRow = rows.at(-1);
    if (lastRow) {
      this.cursors.set(chatId, lastRow.id);
    }
  }
}
