import type * as React from "react";
import { cn } from "@/lib/utils";

/** Centred empty state: an icon or illustration, a title, and a next action. */
export function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-60 w-full flex-col items-center justify-center gap-6 rounded-box p-10",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 text-center", className)}
      {...props}
    />
  );
}

export function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "default" | "icon";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center",
        variant === "icon" &&
          "size-12 rounded-box border border-base-300 bg-base-200 text-base-content/70 [&_svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold", className)} {...props} />;
}

export function EmptyDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p className={cn("text-sm text-base-content/60", className)} {...props} />
  );
}

export function EmptyContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col items-center gap-3", className)}
      {...props}
    />
  );
}
