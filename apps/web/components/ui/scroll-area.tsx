"use client";

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseScrollArea.Root>) {
  return (
    <BaseScrollArea.Root
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <BaseScrollArea.Viewport className="size-full rounded-[inherit] outline-none">
        {children}
      </BaseScrollArea.Viewport>
      <ScrollBar />
      <ScrollBar orientation="horizontal" />
    </BaseScrollArea.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof BaseScrollArea.Scrollbar>) {
  return (
    <BaseScrollArea.Scrollbar
      className={cn(
        "flex touch-none select-none p-px transition-opacity data-scrolling:opacity-100",
        orientation === "vertical" ? "w-2.5 border-l" : "h-2.5 flex-col border-t",
        "border-transparent",
        className,
      )}
      orientation={orientation}
      {...props}
    >
      <BaseScrollArea.Thumb className="relative flex-1 rounded-full bg-base-content/25" />
    </BaseScrollArea.Scrollbar>
  );
}
