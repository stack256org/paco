"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { withAsChild } from "./as-child";

/**
 * Dialog on Base UI, styled with daisyUI's modal classes.
 *
 * The exported names and the `open`/`onOpenChange` contract match what the
 * previous Radix implementation exposed, so the 22 call sites are unchanged.
 * Base UI's part names differ from Radix's — Popup instead of Content, Backdrop
 * instead of Overlay — and those are mapped here rather than at each call site.
 */
export function Dialog(props: React.ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />;
}

export function DialogTrigger({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDialog.Trigger> & { asChild?: boolean }) {
  return <BaseDialog.Trigger {...withAsChild({ asChild, ...props })} />;
}

export function DialogPortal(
  props: React.ComponentProps<typeof BaseDialog.Portal>,
) {
  return <BaseDialog.Portal {...props} />;
}

export function DialogClose({
  asChild,
  ...props
}: React.ComponentProps<typeof BaseDialog.Close> & { asChild?: boolean }) {
  return <BaseDialog.Close {...withAsChild({ asChild, ...props })} />;
}

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Backdrop>) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 transition-opacity duration-150",
        "data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof BaseDialog.Popup> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      {/*
        Deliberately not daisyUI's `modal-box`. That class is styled for daisyUI's
        own modal: it sets opacity 0 and scale 95% and only becomes visible when an
        ancestor `.modal` is open. Base UI owns open state here, so no such
        ancestor exists and the panel stayed invisible — the backdrop appeared and
        the dialog did not. The surface is built from theme tokens instead, and
        Base UI's data-attributes drive the transition.
      */}
      <BaseDialog.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-full max-w-[calc(100%-2rem)] overflow-y-auto",
          "-translate-x-1/2 -translate-y-1/2 rounded-box border border-base-300 bg-base-100 p-5 text-base-content shadow-xl sm:max-w-lg",
          "transition-all duration-150 data-ending-style:scale-95 data-ending-style:opacity-0",
          "data-starting-style:scale-95 data-starting-style:opacity-0",
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
    </DialogPortal>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 pr-8 text-left", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mt-5 flex flex-col-reverse justify-end gap-2 sm:flex-row",
        className,
      )}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      className={cn("text-base font-semibold leading-tight", className)}
      {...props}
    />
  );
}

export function DialogDescription({
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
