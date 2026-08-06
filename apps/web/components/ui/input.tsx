import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `input-sm` is the default: this is a dense console, and the field height needs
 * to match the button scale so inline `join` groups line up.
 */
export function Input({
  className,
  type,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      className={cn("input input-sm w-full", className)}
      type={type}
      {...props}
    />
  );
}
