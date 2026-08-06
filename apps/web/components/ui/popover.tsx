"use client";

import { Popover as BasePopover } from "@base-ui/react/popover";
import * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

export function Popover(props: React.ComponentProps<typeof BasePopover.Root>) {
  return <BasePopover.Root {...props} />;
}

export function PopoverTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof BasePopover.Trigger> & { asChild?: boolean }) {
  return <BasePopover.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof BasePopover.Popup> & {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
  /**
   * Radix focus hooks. Every call site uses these purely to call
   * `preventDefault()` and keep focus where it was, which Base UI expresses
   * declaratively as `initialFocus`/`finalFocus={false}`. The callbacks are
   * still invoked so any side effects they carry continue to run.
   */
  onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
}) {
  /*
   * The popup mounts on open and unmounts on close, so mount and cleanup are
   * exactly the two moments the Radix callbacks fired. Held in refs so the
   * effect runs once per open/close rather than on every prop change — one call
   * site restores the chat textarea's cursor here, and re-running it would
   * fight the user's typing.
   */
  const openFocusRef = React.useRef(onOpenAutoFocus);
  const closeFocusRef = React.useRef(onCloseAutoFocus);
  openFocusRef.current = onOpenAutoFocus;
  closeFocusRef.current = onCloseAutoFocus;

  React.useEffect(() => {
    const event = { preventDefault: () => undefined };
    openFocusRef.current?.(event);
    return () => closeFocusRef.current?.(event);
  }, []);
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner align={align} side={side} sideOffset={sideOffset}>
        <BasePopover.Popup
          className={cn(
            "z-50 w-72 rounded-box border border-base-300 bg-base-100 p-4 text-base-content shadow-lg outline-none",
            "transition-all duration-150 data-ending-style:scale-95 data-ending-style:opacity-0",
            "data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          finalFocus={onCloseAutoFocus ? false : undefined}
          initialFocus={onOpenAutoFocus ? false : undefined}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

/**
 * Base UI positions against the trigger and has no separate anchor part, so this
 * is a passthrough kept for source compatibility with the previous API.
 */
export function PopoverAnchor({ children }: { children?: React.ReactNode }) {
  return children;
}
