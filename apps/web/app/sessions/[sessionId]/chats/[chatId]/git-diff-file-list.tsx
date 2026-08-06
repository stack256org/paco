"use client";

import { useGitPanel } from "./git-panel-context";

import {
  Loader2,
  SquareDot,
  SquareMinus,
  SquarePlus,
  Trash2,
} from "lucide-react";
import type { DiffFile } from "@/app/api/sessions/[sessionId]/diff/route";

function DiffFileStatusIcon({ status }: { status: DiffFile["status"] }) {
  if (status === "added") {
    return <SquarePlus className="h-4 w-4 shrink-0 text-success" />;
  }
  if (status === "deleted") {
    return <SquareMinus className="h-4 w-4 shrink-0 text-error" />;
  }
  if (status === "renamed") {
    return <SquareDot className="h-4 w-4 shrink-0 text-warning" />;
  }
  // modified
  return <SquareDot className="h-4 w-4 shrink-0 text-warning" />;
}

export function isUncommittedFile(file: DiffFile): boolean {
  return file.stagingStatus === "unstaged" || file.stagingStatus === "partial";
}

function canDiscardFile(file: DiffFile): boolean {
  return isUncommittedFile(file);
}

export function DiffFileList({
  files,
  onDiscardFile,
  discardingFilePath,
  discardDisabled,
}: {
  files: DiffFile[];
  onDiscardFile: (file: DiffFile) => void;
  discardingFilePath: string | null;
  discardDisabled: boolean;
}) {
  const { openDiffToFile, diffScope } = useGitPanel();

  const filteredFiles =
    diffScope === "branch" ? files : files.filter(isUncommittedFile);

  if (filteredFiles.length === 0) {
    return (
      <div className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-base-content/25 py-8 text-center">
        <p className="text-xs text-base-content/60">
          {diffScope === "uncommitted"
            ? "No uncommitted changes"
            : "No file changes yet"}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-px">
        {filteredFiles.map((file) => {
          const fileName = file.path.split("/").pop() ?? file.path;
          const dirPath = file.path.slice(0, -fileName.length);

          return (
            <div
              key={file.path}
              className="group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors hover:bg-base-200"
            >
              <button
                type="button"
                onClick={() => openDiffToFile(file.path)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <DiffFileStatusIcon status={file.status} />
                <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
                  <span className="shrink-0 font-mono text-xs font-medium text-base-content">
                    {fileName}
                  </span>
                  {dirPath && (
                    <span
                      className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-base-content/60"
                      dir="rtl"
                    >
                      <bdi>{dirPath.replace(/\/$/, "")}</bdi>
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-[10px]">
                  {file.additions > 0 && (
                    <span className="text-success">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-error">-{file.deletions}</span>
                  )}
                </div>
              </button>
              {canDiscardFile(file) ? (
                <button
                  type="button"
                  onClick={() => onDiscardFile(file)}
                  disabled={discardDisabled || discardingFilePath === file.path}
                  aria-label={`Discard changes in ${file.path}`}
                  className="rounded p-1 text-base-content/60 opacity-0 transition hover:text-error group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-100"
                >
                  {discardingFilePath === file.path ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
