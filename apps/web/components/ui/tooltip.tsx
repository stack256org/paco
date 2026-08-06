"use client";

import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

/**
 * Tooltip on Base UI.
 *
 * daisyUI's `tooltip` class is a CSS-only pseudo-element tooltip driven by a
 * `data-tip` attribute. That cannot carry the rich content used here (icons,
 * shortcut hints, multi-line help), so the surface is styled with theme tokens
 * while Base UI supplies positioning, hover intent, and focus handling.
 */
export function TooltipProvider({
  delay = 0,
  delayDuration,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Provider> & {
  /** Radix's name for `delay`, still used by call sites. */
  delayDuration?: number;
}) {
  return <BaseTooltip.Provider delay={delayDuration ?? delay} {...props} />;
}

export function Tooltip({
  delayDuration,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Root> & {
  /** Radix put the delay on the root; Base UI puts it on the provider. */
  delayDuration?: number;
}) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <BaseTooltip.Root {...props} />
    </TooltipProvider>
  );
}

export function TooltipTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Trigger> & { asChild?: boolean }) {
  return <BaseTooltip.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function TooltipContent({
  className,
  children,
  side = "top",
  sideOffset = 6,
  align = "center",
  ...props
}: React.ComponentProps<typeof BaseTooltip.Popup> & {
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  align?: "start" | "center" | "end";
}) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner align={align} side={side} sideOffset={sideOffset}>
        <BaseTooltip.Popup
          className={cn(
            "z-50 w-fit rounded-field bg-neutral px-2.5 py-1 text-xs text-balance text-neutral-content",
            "transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
