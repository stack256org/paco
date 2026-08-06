"use client";

import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

/**
 * Bottom sheet with swipe-to-dismiss.
 *
 * Replaces `vaul` with Base UI's own Drawer, which keeps the drag gesture and
 * adds a swipe area and handle, so the dependency is no longer needed.
 */
export function Drawer(props: React.ComponentProps<typeof BaseDrawer.Root>) {
  return <BaseDrawer.Root {...props} />;
}

export function DrawerTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Trigger> & { asChild?: boolean }) {
  return <BaseDrawer.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function DrawerPortal(
  props: React.ComponentProps<typeof BaseDrawer.Portal>,
) {
  return <BaseDrawer.Portal {...props} />;
}

export function DrawerClose({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Close> & { asChild?: boolean }) {
  return <BaseDrawer.Close {...withAsChild({ asChild, ...props })} />;
}

export function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Backdrop>) {
  return (
    <BaseDrawer.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-opacity duration-200",
        "data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Popup>) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <BaseDrawer.Popup
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-box border-t border-base-300 bg-base-100 text-base-content outline-none",
          "transition-transform duration-250 ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full",
          className,
        )}
        {...props}
      >
        {/* The grab handle doubles as the swipe target, so the gesture has an
            obvious affordance instead of being hidden anywhere on the panel. */}
        <BaseDrawer.SwipeArea className="flex shrink-0 justify-center py-2">
          <div className="h-1.5 w-12 rounded-full bg-base-300" />
        </BaseDrawer.SwipeArea>
        {children}
      </BaseDrawer.Popup>
    </DrawerPortal>
  );
}

export function DrawerHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 px-4 pb-3", className)}
      {...props}
    />
  );
}

export function DrawerFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-auto flex flex-col gap-2 px-4 pb-4", className)}
      {...props}
    />
  );
}

export function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Title>) {
  return (
    <BaseDrawer.Title
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}

export function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDrawer.Description>) {
  return (
    <BaseDrawer.Description
      className={cn("text-sm text-base-content/60", className)}
      {...props}
    />
  );
}
