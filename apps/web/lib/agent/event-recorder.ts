import type {
  SessionEvent,
  TurnFinishReason,
  TurnPolicy,
  TurnUsage,
} from "@paco/agent-backend";
import { appendSessionEvents } from "@/lib/db/session-events";

type Appender = (chatId: string, events: SessionEvent[]) => Promise<void>;

const CHUNK_FLUSH_SIZE = 50;

/**
 * Batches a turn's session events so chunk volume doesn't turn into row-per-
 * delta insert traffic. All appends go through the never-throwing
 * appendSessionEvents, so recording cannot fail a turn.
 */
export class TurnEventRecorder {
  private readonly chatId: string;
  private readonly turnId: string;
  private readonly append: Appender;
  private pendingChunks: SessionEvent[] = [];
  private loggedPrompt: string | undefined;

  constructor(
    chatId: string,
    turnId: string,
    append: Appender = appendSessionEvents,
  ) {
    this.chatId = chatId;
    this.turnId = turnId;
    this.append = append;
  }

  async start(params: {
    messageId: string;
    prompt: string;
    policy: TurnPolicy;
  }): Promise<void> {
    this.loggedPrompt = params.prompt;
    await this.append(this.chatId, [
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

  chunk(chunk: unknown): void {
    this.pendingChunks.push({
      type: "assistant/chunk",
      turnId: this.turnId,
      chunk,
    });
    if (this.pendingChunks.length >= CHUNK_FLUSH_SIZE) {
      const batch = this.pendingChunks;
      this.pendingChunks = [];
      void this.append(this.chatId, batch);
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
    await this.append(this.chatId, tail);
  }
}
