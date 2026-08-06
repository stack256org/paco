"use client";

import { formatTokens } from "@paco/shared";
import { Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatUsd, type ConversationCost } from "./conversation-usage";

/**
 * The context-window dial in the composer, and the usage breakdown behind it.
 *
 * The ring shows the *last step's* input tokens against the model's context
 * limit — that is what will overflow — while the tooltip totals the whole
 * conversation, which is what costs money. Conflating the two was the previous
 * bug: a long conversation looked like it was about to overflow when each step
 * was nowhere near the limit.
 */
function CircularProgress({
  percentage,
  size = 16,
  strokeWidth = 2,
}: {
  percentage: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90">
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-base-content/20"
      />
      {/* Progress circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        className="text-base-content/60"
      />
    </svg>
  );
}

export function ContextUsageIndicator({
  inputTokens,
  conversationInputTokens,
  conversationCachedInputTokens,
  conversationOutputTokens,
  conversationCost,
  contextLimit,
  onCompact,
  isCompacting = false,
}: {
  inputTokens: number;
  conversationInputTokens: number;
  conversationCachedInputTokens: number;
  conversationOutputTokens: number;
  conversationCost?: ConversationCost;
  contextLimit: number;
  /** Ask the CLI to compact this chat's history. Omitted when unavailable. */
  onCompact?: () => void;
  isCompacting?: boolean;
}) {
  if (inputTokens === 0) {
    return null;
  }

  const percentage =
    contextLimit > 0 ? Math.round((inputTokens / contextLimit) * 100) : 0;
  const uncachedConversationInputTokens = Math.max(
    0,
    conversationInputTokens - conversationCachedInputTokens,
  );

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        {/*
          A button when compaction is possible, a plain readout otherwise.
          The dial used to look interactive and do nothing on click, which
          reads as broken rather than as decoration.
        */}
        <button
          type="button"
          onClick={onCompact}
          disabled={!onCompact || isCompacting}
          aria-label={
            onCompact
              ? `Context ${percentage}% full — compact this chat`
              : `Context ${percentage}% full`
          }
          className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-base-content/60 tabular-nums transition-colors enabled:hover:bg-base-200/60 enabled:hover:text-base-content disabled:cursor-default"
        >
          {/*
            The number drops out in a narrow pane and the ring carries on
            alone. This row sits inside a pane the user can drag down to a
            quarter of the window, where the percentage collided with the
            effort label beside it — the two rendered on top of each other.
            A container query, not a media query: the window can be wide while
            this pane is not.
          */}
          <span className="hidden @[20rem]:inline">{percentage}%</span>
          {isCompacting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CircularProgress
              percentage={percentage}
              size={14}
              strokeWidth={2}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="min-w-[160px] p-0">
        <div className="p-3">
          {/* Header with percentage and token count */}
          <div className="flex items-center justify-between gap-6">
            <span className="text-sm font-medium">{percentage}%</span>
            <span className="text-xs opacity-60">
              {formatTokens(inputTokens)} / {formatTokens(contextLimit)}
            </span>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-current opacity-10" />

        {/* Breakdown */}
        <div className="space-y-1 p-3 text-xs">
          <div className="flex justify-between gap-6">
            <span className="opacity-60">Conversation input</span>
            <span>{formatTokens(conversationInputTokens)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="opacity-60">Cached input</span>
            <span>{formatTokens(conversationCachedInputTokens)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="opacity-60">Uncached input</span>
            <span>{formatTokens(uncachedConversationInputTokens)}</span>
          </div>
          <div className="flex justify-between gap-6">
            <span className="opacity-60">Conversation output</span>
            <span>{formatTokens(conversationOutputTokens)}</span>
          </div>
          {conversationCost !== undefined ? (
            <div className="flex justify-between gap-6">
              <span className="opacity-60">
                {conversationCost.source === "reported"
                  ? "Cost"
                  : conversationCost.source === "mixed"
                    ? "Cost (partial est.)"
                    : "Est. cost"}
              </span>
              <span className="tabular-nums">
                {formatUsd(conversationCost.total)}
              </span>
            </div>
          ) : null}
        </div>

        {onCompact && (
          <>
            <div className="h-px bg-current opacity-10" />
            <p className="p-3 text-xs opacity-60">
              {isCompacting
                ? "Compacting…"
                : "Click to compact — Claude summarises the older history and frees context."}
            </p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
