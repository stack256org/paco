import type { LanguageModelUsage } from "ai";
import type { WebAgentUIMessage } from "@/app/types";
import { estimateModelUsageCost, type AvailableModelCost } from "@/lib/models";

/**
 * Token and cost arithmetic for a conversation.
 *
 * Pure functions over the message list, kept out of the view so they can be
 * tested without rendering anything — the cost rules in particular have real
 * branching, and getting them wrong shows the user a confidently wrong number.
 */

export function formatUsd(amount: number): string {
  if (amount >= 100) {
    return "$" + amount.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (amount >= 1) {
    return (
      "$" +
      amount.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  if (amount >= 0.01) {
    return (
      "$" +
      amount.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return (
    "$" +
    amount.toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  );
}

type MessageUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function getCachedInputTokens(usage: LanguageModelUsage | undefined): number {
  return (
    usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0
  );
}

function getUsageTotals(
  usage: LanguageModelUsage | undefined,
): MessageUsageTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    cachedInputTokens: getCachedInputTokens(usage),
    outputTokens: usage?.outputTokens ?? 0,
  };
}

export function getLatestContextUsage(
  messages: WebAgentUIMessage[],
): MessageUsageTotals {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.metadata?.lastStepUsage) {
      return getUsageTotals(message.metadata.lastStepUsage);
    }
  }

  return getUsageTotals(undefined);
}

export function getConversationUsage(
  messages: WebAgentUIMessage[],
): MessageUsageTotals {
  return messages.reduce<MessageUsageTotals>((total, message) => {
    if (message.role !== "assistant") {
      return total;
    }

    const usage =
      message.metadata?.totalMessageUsage ?? message.metadata?.lastStepUsage;
    if (!usage) {
      return total;
    }

    const usageTotals = getUsageTotals(usage);
    return {
      inputTokens: total.inputTokens + usageTotals.inputTokens,
      cachedInputTokens:
        total.cachedInputTokens + usageTotals.cachedInputTokens,
      outputTokens: total.outputTokens + usageTotals.outputTokens,
    };
  }, getUsageTotals(undefined));
}

type ConversationCostSource = "reported" | "estimate" | "mixed";

export type ConversationCost = {
  total: number;
  source: ConversationCostSource;
};

/**
 * Compute the cumulative USD cost across every assistant message in the
 * conversation. Per-message preference order:
 *   1. `totalMessageCost`, which the Claude Code CLI reports on its result
 *      message. Authoritative when present.
 *   2. Token-based estimate from `totalMessageUsage` / `lastStepUsage`.
 *
 * Returns `undefined` when no cost can be attributed to any message, which
 * hides the row rather than showing a misleading zero. The `source`
 * discriminant lets the UI label the figure honestly: an estimate is marked as
 * one.
 */
export function getConversationCost(
  messages: WebAgentUIMessage[],
  modelCost: AvailableModelCost | undefined,
): ConversationCost | undefined {
  let total = 0;
  let hasAnyCost = false;
  let sawReported = false;
  let sawEstimate = false;

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const reportedCost = message.metadata?.totalMessageCost;
    if (
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0
    ) {
      total += reportedCost;
      hasAnyCost = true;
      sawReported = true;
      continue;
    }

    const usage =
      message.metadata?.totalMessageUsage ?? message.metadata?.lastStepUsage;
    if (!usage) {
      continue;
    }

    const estimatedCost = estimateModelUsageCost(
      getUsageTotals(usage),
      modelCost,
    );
    if (estimatedCost === undefined) {
      continue;
    }

    total += estimatedCost;
    hasAnyCost = true;
    sawEstimate = true;
  }

  if (!hasAnyCost) {
    return undefined;
  }

  const source: ConversationCostSource =
    sawReported && sawEstimate
      ? "mixed"
      : sawReported
        ? "reported"
        : "estimate";

  return { total, source };
}
