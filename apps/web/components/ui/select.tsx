"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Select on Base UI, styled with daisyUI's `select` for the trigger and a themed
 * popup for the list.
 *
 * Base UI splits the list across Portal / Positioner / Popup where Radix had a
 * single Content; that is assembled inside `SelectContent` so call sites keep
 * their original shape.
 */
/**
 * Base UI types the selected value as `unknown` because a Select can carry any
 * payload. Every call site here uses plain strings, so the callback is narrowed
 * rather than making each one cast.
 */
export function Select({
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof BaseSelect.Root>, "onValueChange"> & {
  onValueChange?: (value: string) => void;
}) {
  return (
    <BaseSelect.Root
      {...props}
      onValueChange={(value) => onValueChange?.(value as string)}
    />
  );
}

export function SelectGroup(
  props: React.ComponentProps<typeof BaseSelect.Group>,
) {
  return <BaseSelect.Group {...props} />;
}

export function SelectValue(
  props: React.ComponentProps<typeof BaseSelect.Value>,
) {
  return <BaseSelect.Value {...props} />;
}

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Trigger>) {
  return (
    // daisyUI's `select` already draws the chevron as a background image, so
    // rendering BaseSelect.Icon here as well produced two of them.
    <BaseSelect.Trigger
      className={cn(
        "select select-sm w-full items-center gap-2 text-left",
        className,
      )}
      {...props}
    >
      {children}
    </BaseSelect.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof BaseSelect.Popup> & {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        align={align}
        /*
         * Base UI defaults to placing the *selected item* over the trigger, the
         * way a native macOS select behaves. Here that put the open list on top
         * of the field and its label, offset to the left and unrelated to the
         * control it belonged to. A dropdown that opens below its trigger is
         * what the rest of this UI does, so say so explicitly.
         */
        alignItemWithTrigger={false}
        side={side}
        sideOffset={sideOffset}
      >
        <BaseSelect.Popup
          className={cn(
            // `--anchor-width` is the trigger's width, so the list lines up with
            // the field instead of shrinking to its own content.
            "z-50 max-h-72 w-(--anchor-width) min-w-32 overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 text-base-content shadow-lg outline-none",
            "transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  );
}

export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof BaseSelect.GroupLabel>) {
  return (
    <BaseSelect.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-base-content/60", className)}
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseSelect.Item>) {
  return (
    <BaseSelect.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none",
        "data-highlighted:bg-base-200 data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-2 flex items-center">
        <CheckIcon aria-hidden="true" className="size-4" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("-mx-1 my-1 h-px bg-base-300", className)} {...props} />;
}
