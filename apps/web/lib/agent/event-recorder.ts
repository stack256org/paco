import type {
  SessionEvent,
  TurnFinishReason,
  TurnPolicy,
  TurnUsage,
} from "@paco/agent-backend";
import { appendSessionEvents } from "@/lib/db/session-events";

/**
 * Appends one batch of events for a chat.
 *
 * Must never throw or reject: `TurnEventRecorder` chains every call off the
 * previous one's settlement, and a rejection that escaped that chain would
 * surface as an unhandled rejection rather than a caught error. The default,
 * `appendSessionEvents`, already upholds this by catching internally.
 */
type Appender = (chatId: string, events: SessionEvent[]) => Promise<void>;

const CHUNK_FLUSH_SIZE = 50;

/**
 * Batches a turn's session events so chunk volume doesn't turn into row-per-
 * delta insert traffic. All appends go through the never-throwing
 * appendSessionEvents, so recording cannot fail a turn.
 *
 * Every append is serialized through one promise chain (`appendChain`)
 * rather than fired independently. The underlying store assigns ids in
 * insert order, not call order, so on a pooled client two concurrent
 * appends can land out of order — a `turn/end` racing ahead of an earlier
 * `assistant/chunk` batch would get a lower id than a row that logically
 * precedes it, breaking replay-by-id. Chaining makes each append wait for
 * every append enqueued before it, so completion order always matches
 * enqueue order.
 */
export class TurnEventRecorder {
  private readonly chatId: string;
  private readonly turnId: string;
  private readonly append: Appender;
  private pendingChunks: SessionEvent[] = [];
  private loggedPrompt: string | undefined;
  private appendChain: Promise<void> = Promise.resolve();

  constructor(
    chatId: string,
    turnId: string,
    append: Appender = appendSessionEvents,
  ) {
    this.chatId = chatId;
    this.turnId = turnId;
    this.append = append;
  }

  /**
   * The turn id this recorder was constructed with.
   *
   * Exposed so a caller that only holds the recorder (not the id it passed
   * into the constructor) can still recover it — e.g. threading it out of a
   * step's return value for post-turn work keyed on the same turn, such as
   * memory distillation.
   */
  getTurnId(): string {
    return this.turnId;
  }

  /**
   * Enqueue a batch behind every previously enqueued batch.
   *
   * The `.catch` here is defensive, not the primary contract: `Appender`
   * must never reject. It exists so a misbehaving injected appender (e.g. in
   * a test) can't turn `appendChain` into a permanently-rejected promise —
   * which would fail every subsequent append forever — or produce an
   * unhandled rejection.
   */
  private enqueue(events: SessionEvent[]): Promise<void> {
    this.appendChain = this.appendChain
      .then(() => this.append(this.chatId, events))
      .catch((error: unknown) => {
        console.error("event-recorder: append failed", error);
      });
    return this.appendChain;
  }

  /**
   * Log the turn's opening pair: `turn/start` and `user/message`.
   *
   * `messageId` is the USER's `chatMessages` row — the row that holds
   * `prompt` — for BOTH events, not the assistant row the turn will
   * eventually write. `turn/start` carries the prompt, so the id beside it
   * names the message that IS that prompt; `lib/evals/runner.ts` already
   * correlates `turn/start.messageId` against the user message id it
   * submitted. The assistant row is the wrong answer for a second reason:
   * on the continuation path it does not exist yet when this runs, so the
   * event would name a row that is not there.
   *
   * The assistant side is not lost by this: a turn's assistant output is
   * keyed by `turnId` (`assistant/chunk`, `usage/reported`, `turn/end`) and
   * `deriveAssistantMessage` stamps whichever message id its caller wants.
   */
  async start(params: {
    messageId: string;
    prompt: string;
    policy: TurnPolicy;
  }): Promise<void> {
    this.loggedPrompt = params.prompt;
    await this.enqueue([
      {
        type: "turn/start",
        turnId: this.turnId,
        messageId: params.messageId,
        prompt: params.prompt,
        policy: params.policy,
      },
      {
        type: "user/message",
        turnId: this.turnId,
        messageId: params.messageId,
        text: params.prompt,
      },
    ]);
  }

  /**
   * Spec 1a runtime invariant: what is sent to the model must equal what was
   * logged. Called by the workflow just before dispatching the turn.
   */
  assertPromptLogged(prompt: string): void {
    if (this.loggedPrompt !== prompt) {
      throw new Error(
        "session-events invariant violated: the dispatched prompt differs from the logged user/message",
      );
    }
  }

  /**
   * Log the model-visible context this turn was dispatched with beyond its
   * prompt — see `turn/context` in `packages/agent-backend/events.ts`.
   *
   * A no-op when nothing was injected, so a turn that retrieved no memory
   * and attached no agents/skills/MCP servers doesn't add an empty row.
   */
  async context(params: {
    memorySection?: string;
    agents?: string[];
    skills?: string[];
    mcpServers?: string[];
  }): Promise<void> {
    const hasAny =
      params.memorySection !== undefined ||
      (params.agents?.length ?? 0) > 0 ||
      (params.skills?.length ?? 0) > 0 ||
      (params.mcpServers?.length ?? 0) > 0;
    if (!hasAny) {
      return;
    }
    await this.enqueue([
      {
        type: "turn/context",
        turnId: this.turnId,
        ...(params.memorySection !== undefined
          ? { memorySection: params.memorySection }
          : {}),
        ...(params.agents?.length ? { agents: params.agents } : {}),
        ...(params.skills?.length ? { skills: params.skills } : {}),
        ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
      },
    ]);
  }

  chunk(chunk: unknown): void {
    this.pendingChunks.push({
      type: "assistant/chunk",
      turnId: this.turnId,
      chunk,
    });
    if (this.pendingChunks.length >= CHUNK_FLUSH_SIZE) {
      const batch = this.pendingChunks;
      this.pendingChunks = [];
      void this.enqueue(batch);
    }
  }

  async finish(params: {
    finishReason: TurnFinishReason;
    isError: boolean;
    usage?: TurnUsage;
    costUsd?: number;
    steered?: { text: string };
  }): Promise<void> {
    const tail: SessionEvent[] = [...this.pendingChunks];
    this.pendingChunks = [];
    if (params.usage) {
      tail.push({
        type: "usage/reported",
        turnId: this.turnId,
        usage: params.usage,
        ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
      });
    }
    tail.push({
      type: "turn/end",
      turnId: this.turnId,
      finishReason: params.finishReason,
      isError: params.isError,
      ...(params.steered ? { steered: params.steered } : {}),
    });
    await this.enqueue(tail);
  }
}
