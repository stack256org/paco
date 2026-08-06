"use client";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFileIcon } from "@/components/file-type-icons";
import { useOpenFile } from "./open-file-context";

function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function FileNamePill({
  filePath,
  fullPath,
  error = false,
}: {
  filePath: string;
  fullPath?: string;
  error?: boolean;
}) {
  const onOpenFile = useOpenFile();
  const fileName = getFileName(filePath);
  const tooltipPath = fullPath ?? filePath;
  const showTooltip = tooltipPath !== fileName;
  const isClickable = onOpenFile !== null;

  const handleClick = (e: React.MouseEvent) => {
    if (!onOpenFile) return;
    e.stopPropagation(); // Don't trigger parent tool call expand
    onOpenFile(filePath);
  };

  const errorStyles = error ? "border-error/30 bg-error/10 text-error" : "";
  const normalStyles = error
    ? ""
    : "border-base-300/80 bg-base-200/60 text-base-content/60";
  const hoverStyles = error
    ? "hover:border-error/30 hover:bg-error/10"
    : "hover:border-base-content/20 hover:bg-base-200 hover:shadow-sm hover:ring-1 hover:ring-base-content/5";

  const icon = getFileIcon(fileName, {
    className: "h-3.5 w-3.5 shrink-0 mr-1",
  });

  const pill = isClickable ? (
    <button
      type="button"
      onClick={handleClick}
      title={showTooltip ? undefined : `Open ${fileName}`}
      className={cn(
        "inline-flex max-w-[220px] cursor-pointer items-center rounded border px-1.5 py-0.5 font-mono text-[12px] leading-tight transition-all",
        normalStyles,
        errorStyles,
        hoverStyles,
      )}
    >
      {icon}
      <span className="truncate">{fileName}</span>
    </button>
  ) : (
    <span
      className={cn(
        "inline-flex max-w-[220px] items-center rounded border px-1.5 py-0.5 font-mono text-[12px] leading-tight",
        normalStyles,
        errorStyles,
      )}
    >
      {icon}
      <span className="truncate">{fileName}</span>
    </span>
  );

  if (!showTooltip) return pill;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="top">
        <span className="font-mono text-xs">{tooltipPath}</span>
      </TooltipContent>
    </Tooltip>
  );
}
