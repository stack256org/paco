"use client";

import { Terminal } from "lucide-react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function BashRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-bash">) {
  const input = part.input;
  const command = String(input?.command ?? "");
  const cwd = input?.cwd;
  const isDetached = input?.detached === true;

  const output = part.state === "output-available" ? part.output : undefined;
  const exitCode = output?.exitCode;
  const stdout = output?.stdout;
  const stderr = output?.stderr;
  const hasOutput = Boolean(stdout || stderr);
  const toolFailed = output?.success === false;
  const isError =
    toolFailed || (typeof exitCode === "number" && exitCode !== 0);

  const combinedOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
  const hasExpandableContent =
    part.state === "output-available" || Boolean(cwd) || isDetached;

  // When bash errors, route through the standard error UI in ToolLayout.
  // The minimized view will show: [CircleX] Error  Exit code N
  // The expanded view uses our custom card below.
  const mergedState =
    isError && !state.error
      ? { ...state, error: `Exit code ${exitCode ?? "unknown"}` }
      : state;

  const meta = isDetached ? (
    <span className="rounded bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info">
      detached
    </span>
  ) : undefined;

  const errorMetaContent =
    isError && exitCode !== undefined ? `exit ${exitCode}` : undefined;

  const expandedContent = hasExpandableContent ? (
    isError ? (
      hasOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-error/30 bg-error/10 px-3 py-2 font-mono text-xs leading-relaxed text-error">
          {combinedOutput}
        </pre>
      ) : undefined
    ) : (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-base-300 bg-base-200/50 p-3 font-mono text-xs leading-relaxed text-base-content/60">
        {hasOutput ? combinedOutput : "(No output)"}
      </pre>
    )
  ) : undefined;

  return (
    <ToolLayout
      name="Bash"
      summary={command || "..."}
      summaryClassName="font-mono"
      meta={meta}
      errorMeta={errorMetaContent}
      state={mergedState}
      icon={<Terminal className="h-3.5 w-3.5" />}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
