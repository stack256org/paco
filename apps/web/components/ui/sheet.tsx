"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

/**
 * Edge-anchored dialog.
 *
 * Built on Base UI's Dialog rather than its Drawer: this is a modal panel pinned
 * to an edge with no swipe-to-dismiss, and Dialog gives exactly that without the
 * drag machinery.
 */
export function Sheet(props: React.ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />;
}

export function SheetTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDialog.Trigger> & { asChild?: boolean }) {
  return <BaseDialog.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function SheetClose({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDialog.Close> & { asChild?: boolean }) {
  return <BaseDialog.Close {...withAsChild({ asChild, ...props })} />;
}

export function SheetPortal(
  props: React.ComponentProps<typeof BaseDialog.Portal>,
) {
  return <BaseDialog.Portal {...props} />;
}

export function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Backdrop>) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-opacity duration-200",
        "data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

const SIDE_CLASS = {
  top: "inset-x-0 top-0 border-b data-ending-style:-translate-y-full data-starting-style:-translate-y-full",
  bottom:
    "inset-x-0 bottom-0 border-t data-ending-style:translate-y-full data-starting-style:translate-y-full",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-ending-style:-translate-x-full data-starting-style:-translate-x-full",
  right:
    "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm data-ending-style:translate-x-full data-starting-style:translate-x-full",
} as const;

export function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & {
  side?: keyof typeof SIDE_CLASS;
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <BaseDialog.Popup
        className={cn(
          "fixed z-50 flex flex-col gap-4 border-base-300 bg-base-100 p-4 text-base-content shadow-lg outline-none",
          "transition-transform duration-200 ease-out",
          SIDE_CLASS[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <BaseDialog.Close
            aria-label="Close"
            className="btn btn-ghost btn-xs btn-circle absolute top-3 right-3"
          >
            <XIcon className="size-4" />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </SheetPortal>
  );
}

export function SheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />
  );
}

export function SheetFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("mt-auto flex flex-col gap-2", className)} {...props} />
  );
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      className={cn("text-sm text-base-content/60", className)}
      {...props}
    />
  );
}
