"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A plain `<label>` rather than Base UI's Field.Label, because most call sites
 * pair it with an input by `htmlFor` and are not inside a Field. daisyUI's
 * `label` class is scoped to inputs it wraps, so the styling here is the type
 * treatment only.
 */
export function Label({
  className,
  ...props
}: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex select-none items-center gap-2 text-sm font-medium leading-none",
        "has-disabled:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
