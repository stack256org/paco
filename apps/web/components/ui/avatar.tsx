"use client";

import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Avatar on Base UI with daisyUI's `avatar` wrapper.
 *
 * The size is published as a `data-size` attribute and read by the descendants
 * through group variants, which is how the badge and group count scale without
 * every call site restating the size.
 */
const SIZE_CLASS = {
  sm: "size-6",
  default: "size-8",
  lg: "size-10",
} as const;

export function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof BaseAvatar.Root> & {
  size?: keyof typeof SIZE_CLASS;
}) {
  return (
    <BaseAvatar.Root
      className={cn(
        "avatar group/avatar relative shrink-0 rounded-full",
        SIZE_CLASS[size],
        className,
      )}
      data-size={size}
      {...props}
    />
  );
}

export function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof BaseAvatar.Image>) {
  return (
    <BaseAvatar.Image
      className={cn("size-full rounded-full object-cover", className)}
      {...props}
    />
  );
}

export function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof BaseAvatar.Fallback>) {
  return (
    <BaseAvatar.Fallback
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-base-300 text-sm text-base-content/70",
        "group-data-[size=sm]/avatar:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarBadge({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex select-none items-center justify-center rounded-full bg-primary text-primary-content ring-2 ring-base-100",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarGroup({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "avatar-group group/avatar-group flex -space-x-2 *:ring-2 *:ring-base-100",
        className,
      )}
      {...props}
    />
  );
}

export function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-base-300 text-sm text-base-content/70 ring-2 ring-base-100",
        "group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6",
        "[&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}
