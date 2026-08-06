"use client";

import { toRelativePath } from "@paco/shared/lib/tool-state";
import { Pencil } from "lucide-react";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { defaultDiffOptions } from "@/lib/diffs-config";
import { ToolLayout } from "../tool-layout";
import { FileNamePill } from "../file-name-pill";
import { useCodeTheme } from "@/hooks/use-code-theme";

export function EditRenderer({
  part,
  state,
  cwd = "",
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-edit">) {
  const codeTheme = useCodeTheme();
  const input = part.input;
  const rawFilePath = input?.filePath ?? "...";
  const filePath =
    rawFilePath === "..." ? rawFilePath : toRelativePath(rawFilePath, cwd);
  const oldString = input?.oldString ?? "";
  const newString = input?.newString ?? "";

  const { additions, removals } = useMemo(() => {
    const oldLines = oldString.split("\n");
    const newLines = newString.split("\n");

    const oldCounts = new Map<string, number>();
    for (const line of oldLines) {
      oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    }

    const newCounts = new Map<string, number>();
    for (const line of newLines) {
      newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
    }

    let add = 0;
    for (const [line, count] of newCounts) {
      add += Math.max(0, count - (oldCounts.get(line) ?? 0));
    }

    let remove = 0;
    for (const [line, count] of oldCounts) {
      remove += Math.max(0, count - (newCounts.get(line) ?? 0));
    }

    return { additions: add, removals: remove };
  }, [oldString, newString]);

  const output = part.state === "output-available" ? part.output : undefined;
  const outputError =
    output?.success === false ? (output?.error ?? "Edit failed") : undefined;

  const mergedState = outputError
    ? { ...state, error: state.error ?? outputError }
    : state;

  const showDiff =
    mergedState.approvalRequested ||
    (!mergedState.running && !mergedState.error && !mergedState.denied);

  const expandedContent =
    showDiff && !mergedState.denied ? (
      <div className="max-h-96 overflow-auto rounded-md border border-base-300">
        <MultiFileDiff
          disableWorkerPool
          oldFile={{ name: rawFilePath, contents: oldString }}
          newFile={{ name: rawFilePath, contents: newString }}
          options={{ ...defaultDiffOptions, theme: codeTheme }}
        />
      </div>
    ) : undefined;

  const meta =
    showDiff && !mergedState.denied ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-success">+{additions}</span>
        <span className="text-error">-{removals}</span>
      </span>
    ) : undefined;

  return (
    <ToolLayout
      name="Update"
      icon={<Pencil className="h-3.5 w-3.5" />}
      summary={
        filePath === "..." ? (
          filePath
        ) : (
          <FileNamePill
            filePath={filePath}
            fullPath={rawFilePath}
            error={Boolean(mergedState.error)}
          />
        )
      }
      meta={meta}
      errorMeta={mergedState.error ? "failed" : undefined}
      state={mergedState}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
