"use client";

import { Menu } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

/**
 * Dropdown menu on Base UI, styled with daisyUI's `menu`.
 *
 * Base UI calls this component Menu and splits the surface across
 * Portal / Positioner / Popup; the Radix-shaped exports are preserved so the ten
 * call sites did not change.
 */
export function DropdownMenu(props: React.ComponentProps<typeof Menu.Root>) {
  return <Menu.Root {...props} />;
}

export function DropdownMenuTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof Menu.Trigger> & { asChild?: boolean }) {
  return <Menu.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function DropdownMenuGroup(props: React.ComponentProps<typeof Menu.Group>) {
  return <Menu.Group {...props} />;
}

export function DropdownMenuPortal(
  props: React.ComponentProps<typeof Menu.Portal>,
) {
  return <Menu.Portal {...props} />;
}

export function DropdownMenuSub(
  props: React.ComponentProps<typeof Menu.SubmenuRoot>,
) {
  return <Menu.SubmenuRoot {...props} />;
}

export function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof Menu.RadioGroup>,
) {
  return <Menu.RadioGroup {...props} />;
}

export function DropdownMenuContent({
  className,
  children,
  align = "start",
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof Menu.Popup> & {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner align={align} side={side} sideOffset={sideOffset}>
        <Menu.Popup
          className={cn(
            "menu menu-sm z-50 min-w-[8rem] flex-nowrap rounded-box border border-base-300 bg-base-100 p-1 text-base-content shadow-lg outline-none",
            "transition-all duration-100 data-ending-style:scale-95 data-ending-style:opacity-0",
            "data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

const ITEM_CLASS = cn(
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
  "data-highlighted:bg-base-200 data-disabled:pointer-events-none data-disabled:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
);

export function DropdownMenuItem({
  className,
  variant = "default",
  asChild,
  ...props
}: React.ComponentProps<typeof Menu.Item> & {
  variant?: "default" | "destructive";
  asChild?: boolean;
}) {
  return (
    <Menu.Item
      className={cn(
        ITEM_CLASS,
        variant === "destructive" && "text-error data-highlighted:bg-error/10",
        className,
      )}
      {...withAsChild({ asChild, ...props })}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(ITEM_CLASS, "pl-8")} {...props}>
      <Menu.CheckboxItemIndicator className="absolute left-2 flex items-center">
        <CheckIcon aria-hidden="true" className="size-4" />
      </Menu.CheckboxItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(ITEM_CLASS, "pl-8", className)} {...props}>
      <Menu.RadioItemIndicator className="absolute left-2 flex items-center">
        <CircleIcon aria-hidden="true" className="size-2 fill-current" />
      </Menu.RadioItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof Menu.GroupLabel>) {
  return (
    <Menu.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-base-content/60", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("-mx-1 my-1 h-px bg-base-300", className)} {...props} />;
}

export function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest text-base-content/60", className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Menu.SubmenuTrigger>) {
  return (
    <Menu.SubmenuTrigger className={cn(ITEM_CLASS, className)} {...props}>
      {children}
      <ChevronRightIcon aria-hidden="true" className="ml-auto size-4" />
    </Menu.SubmenuTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Popup>) {
  return (
    <Menu.Portal>
      <Menu.Positioner>
        <Menu.Popup
          className={cn(
            "menu menu-sm z-50 min-w-[8rem] rounded-box border border-base-300 bg-base-100 p-1 shadow-lg outline-none",
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  );
}
