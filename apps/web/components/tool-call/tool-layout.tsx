"use client";

import type { ToolRenderState } from "@paco/shared/lib/tool-state";
import { CircleX, Loader2, Minus, OctagonPause, Plus } from "lucide-react";
import type React from "react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ApprovalButtons } from "./approval-buttons";

export type ToolLayoutProps = {
  name: string;
  summary: ReactNode;
  summaryClassName?: string;
  meta?: ReactNode;
  /** When true, push meta to the far right of the header row. */
  rightAlignMeta?: boolean;
  /** Short label shown right-aligned in the error header (e.g. "exit 1"). */
  errorMeta?: ReactNode;
  state: ToolRenderState;
  output?: ReactNode;
  children?: ReactNode;
  expandedContent?: ReactNode;
  onApprove?: (id: string) => void;
  onDeny?: (id: string, reason?: string) => void;
  defaultExpanded?: boolean;
  /** Tool-specific icon (Lucide element). */
  icon?: ReactNode;
  /** @deprecated Use `icon` instead. */
  indicator?: ReactNode;
  nameClassName?: string;
};

function StatusIndicator({ state }: { state: ToolRenderState }) {
  if (state.interrupted) {
    return (
      <span className="inline-block h-2 w-2 rounded-full border border-warning" />
    );
  }

  if (state.running) {
    return <Loader2 className="h-3 w-3 animate-spin text-warning" />;
  }

  const color = state.denied
    ? "bg-error"
    : state.approvalRequested
      ? "bg-warning"
      : state.error
        ? "bg-error"
        : "bg-success";

  return <span className={cn("inline-block h-2 w-2 rounded-full", color)} />;
}

function hasRenderableContent(value: ReactNode) {
  return (
    value !== null && value !== undefined && value !== false && value !== ""
  );
}

const EXPANDED_CONTENT_TRANSITION_MS = 200;

function trimErrorPrefix(message: string) {
  return message.replace(/^Error:\s*/i, "").trim();
}

export function ToolLayout({
  name,
  summary,
  summaryClassName,
  meta,
  rightAlignMeta = false,
  errorMeta,
  state,
  output,
  children,
  expandedContent,
  onApprove,
  onDeny,
  defaultExpanded = false,
  icon,
  indicator,
  nameClassName,
}: ToolLayoutProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const showApprovalButtons = Boolean(
    state.approvalRequested && !state.isActiveApproval && state.approvalId,
  );
  const errorMessage =
    state.error && !state.denied ? trimErrorPrefix(state.error) : undefined;
  const hasError = Boolean(errorMessage);
  const isInterrupted = Boolean(state.interrupted);
  const hasExpandedDetails =
    hasRenderableContent(expandedContent) || hasError || isInterrupted;
  const hasOutput = hasRenderableContent(output);
  const hasMeta = hasRenderableContent(meta);
  const hasSummary =
    typeof summary === "string" ? summary.trim().length > 0 : summary != null;
  const showRunningNotice =
    state.approvalRequested && !showApprovalButtons && !state.interrupted;
  const isExpandedPanelVisible = isExpanded && hasExpandedDetails;
  const [shouldRenderExpandedContent, setShouldRenderExpandedContent] =
    useState(defaultExpanded && hasExpandedDetails);

  // Error & interrupted state flags
  const showErrorHeader = hasError;
  const showInterruptedHeader = isInterrupted && !hasError;
  const showErrorExpanded = hasError && isExpandedPanelVisible;
  const showInterruptedExpanded =
    isInterrupted && !hasError && isExpandedPanelVisible;
  const hasErrorMeta = hasRenderableContent(errorMeta);
  const hasTrailingMeta = !showErrorHeader && !showInterruptedHeader && hasMeta;

  useEffect(() => {
    if (!hasExpandedDetails) {
      setShouldRenderExpandedContent(false);
      return;
    }

    if (isExpandedPanelVisible) {
      setShouldRenderExpandedContent(true);
      return;
    }

    if (!shouldRenderExpandedContent) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRenderExpandedContent(false);
    }, EXPANDED_CONTENT_TRANSITION_MS);

    return () => window.clearTimeout(timeoutId);
  }, [hasExpandedDetails, isExpandedPanelVisible, shouldRenderExpandedContent]);

  const handleToggle = () => {
    if (!hasExpandedDetails) {
      return;
    }

    const nextExpanded = !isExpanded;

    if (nextExpanded) {
      setShouldRenderExpandedContent(true);
    }

    setIsExpanded(nextExpanded);
  };

  // Resolve the icon to show in the header.
  const isRunning = state.running;
  const resolvedIcon = isRunning ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin text-base-content/60" />
  ) : (
    (icon ?? indicator ?? <StatusIndicator state={state} />)
  );

  return (
    <div className="-mx-1.5 rounded-md border border-transparent bg-transparent">
      <div
        className={cn(
          "group flex min-w-0 select-none items-center gap-2 rounded-md px-1.5 py-1 text-sm",
          hasExpandedDetails &&
            "cursor-pointer transition-colors hover:bg-base-200/50",
        )}
        {...(hasExpandedDetails && {
          onClick: handleToggle,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggle();
            }
          },
          role: "button",
          tabIndex: 0,
          "aria-expanded": isExpanded,
        })}
      >
        {/* Icon area */}
        <span className="flex size-4 shrink-0 items-center justify-center text-base-content/70">
          {showErrorHeader ? (
            <>
              <CircleX className="h-3.5 w-3.5 text-error group-hover:hidden" />
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              )}
            </>
          ) : showInterruptedHeader ? (
            <>
              <OctagonPause className="h-3.5 w-3.5 text-warning group-hover:hidden" />
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              )}
            </>
          ) : hasExpandedDetails && !isRunning ? (
            <>
              <span className="group-hover:hidden">{resolvedIcon}</span>
              {isExpandedPanelVisible ? (
                <Minus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              ) : (
                <Plus className="hidden h-3.5 w-3.5 text-base-content/60 group-hover:block" />
              )}
            </>
          ) : (
            resolvedIcon
          )}
        </span>

        {/* Name + summary */}
        <span
          className={cn(
            "min-w-0 shrink truncate font-medium leading-none",
            showErrorHeader
              ? "text-error"
              : showInterruptedHeader
                ? "text-warning"
                : state.denied
                  ? "text-error"
                  : "text-base-content",
            nameClassName,
          )}
        >
          {name}
        </span>

        <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          {hasSummary && (
            <span
              className={cn(
                "min-w-0 shrink truncate font-mono text-[13px] leading-none",
                showErrorHeader
                  ? "text-error/80"
                  : showInterruptedHeader
                    ? "text-warning/80"
                    : "text-base-content/60",
                summaryClassName,
              )}
            >
              {summary}
            </span>
          )}

          {(rightAlignMeta || showErrorHeader || showInterruptedHeader) && (
            <span className="flex-1" />
          )}

          {showErrorHeader && hasErrorMeta && (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] leading-none text-error/70">
              {errorMeta}
            </span>
          )}

          {hasTrailingMeta && (
            <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px] leading-none text-base-content/60">
              {meta}
            </span>
          )}
        </div>
      </div>

      {children}

      {showRunningNotice && (
        <div className="mt-2 text-sm text-base-content/60">Running...</div>
      )}

      {showApprovalButtons && (
        <div
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <ApprovalButtons
            approvalId={state.approvalId!}
            onApprove={onApprove}
            onDeny={onDeny}
          />
        </div>
      )}

      {hasOutput &&
        !state.approvalRequested &&
        !state.denied &&
        !state.interrupted && (
          <div className="mt-2 text-sm text-base-content/60">{output}</div>
        )}

      {state.denied && (
        <div className="mt-2 text-sm text-error">
          Denied{state.denialReason ? `: ${state.denialReason}` : ""}
        </div>
      )}

      {hasExpandedDetails && (
        <div
          aria-hidden={!isExpandedPanelVisible}
          inert={!isExpandedPanelVisible}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity,margin-top] motion-reduce:transition-none",
            isExpandedPanelVisible
              ? "mt-1.5 grid-rows-[1fr] opacity-100 duration-200 ease-out"
              : "grid-rows-[0fr] opacity-0 pointer-events-none duration-150 ease-out",
          )}
        >
          <div className="min-h-0 min-w-0">
            {shouldRenderExpandedContent && (
              <div className="space-y-2 pb-1">
                {showErrorExpanded &&
                  !hasRenderableContent(expandedContent) && (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-error/30 bg-error/10 px-3 py-2 font-mono text-xs leading-relaxed text-error">
                      {errorMessage}
                    </pre>
                  )}
                {showInterruptedExpanded && (
                  <pre className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 font-mono text-xs leading-relaxed text-warning">
                    interrupted
                  </pre>
                )}
                {expandedContent}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
