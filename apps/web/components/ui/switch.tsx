"use client";

import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * daisyUI's `toggle` styles a checkbox input; Base UI renders a button with the
 * switch role and a separate thumb, so the track and thumb are styled from theme
 * tokens to match the toggle's proportions.
 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-base-300 p-0.5 transition-colors",
        "bg-base-300 data-checked:bg-primary",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-base-100 shadow transition-transform",
          "data-checked:translate-x-4 data-checked:bg-primary-content",
        )}
      />
    </BaseSwitch.Root>
  );
}
