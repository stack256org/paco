import type { LanguageModelUsage } from "ai";
import type { WebAgentUIMessage } from "@/app/types";

/** Usage reported by one subagent (`task` tool) invocation. */
export interface TaskToolUsageEvent {
  /** Identifies the invocation so already-counted events can be skipped. */
  toolCallId?: string;
  modelId?: string;
  usage: LanguageModelUsage;
}

function addOptional(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

/**
 * Add two usage records.
 *
 * Returns whichever side is defined when only one is, so callers can fold over
 * a list without seeding an empty record.
 */
export function sumLanguageModelUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: addOptional(a.cachedInputTokens, b.cachedInputTokens),
    inputTokenDetails: {
      noCacheTokens: addOptional(
        a.inputTokenDetails?.noCacheTokens,
        b.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: addOptional(
        a.inputTokenDetails?.cacheReadTokens,
        b.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: addOptional(
        a.inputTokenDetails?.cacheWriteTokens,
        b.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokenDetails: {
      textTokens: addOptional(
        a.outputTokenDetails?.textTokens,
        b.outputTokenDetails?.textTokens,
      ),
      reasoningTokens: addOptional(
        a.outputTokenDetails?.reasoningTokens,
        b.outputTokenDetails?.reasoningTokens,
      ),
    },
  };
}

/**
 * Pull per-subagent usage out of completed `task` tool parts.
 *
 * Subagent tokens are billed under the delegated model, not the orchestrator's,
 * so they are attributed separately in the usage breakdown. Parts that finished
 * without reporting usage are skipped.
 */
export function collectTaskToolUsageEvents(
  message: WebAgentUIMessage | undefined,
): TaskToolUsageEvent[] {
  if (!message) {
    return [];
  }

  const events: TaskToolUsageEvent[] = [];

  for (const part of message.parts) {
    if (part.type !== "tool-task" || part.state !== "output-available") {
      continue;
    }

    const output = part.output;
    if (!output || typeof output !== "object") {
      continue;
    }

    const usage = (output as { usage?: LanguageModelUsage }).usage;
    if (!usage) {
      continue;
    }

    events.push({
      toolCallId: part.toolCallId,
      modelId: (output as { modelId?: string }).modelId,
      usage,
    });
  }

  return events;
}
