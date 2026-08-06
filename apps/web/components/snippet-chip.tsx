"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SnippetChipProps {
  filename: string;
  content: string;
  className?: string;
}

export function SnippetChip({
  filename,
  content,
  className,
}: SnippetChipProps) {
  const [open, setOpen] = useState(false);
  const lineCount = content.split("\n").length;
  const byteSize = new Blob([content]).size;
  const meta = `${lineCount} lines · ${formatBytes(byteSize)}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-xl bg-base-200/70 px-3 py-1.5",
          "font-mono text-xs leading-tight text-base-content/60",
          "transition-colors hover:bg-base-200 hover:text-base-content",
          className,
        )}
        title={`${filename}\n${meta}`}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{filename}</span>
        <span className="shrink-0 text-[10px] opacity-60">{meta}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              <FileText className="h-4 w-4 shrink-0 text-base-content/60" />
              <span>{filename}</span>
              <span className="text-xs font-normal text-base-content/60">
                {meta}
              </span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Preview the attached text snippet content.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-base-200/40 p-4">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-base-content">
              {content}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
