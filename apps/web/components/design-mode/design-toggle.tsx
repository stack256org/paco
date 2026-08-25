"use client";

import { Palette } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DesignToggleProps {
  active: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * The composer's Design switch.
 *
 * Always visible, and per-message rather than per-chat: it decides how the
 * *next* send runs (the send adds `mode: "design"` to the request body), so
 * there is nothing chat-scoped to store. A design turn is expensive — N
 * parallel designer turns in N worktrees — which is exactly why it is a
 * deliberate press before one message and not a mode a chat sits in.
 *
 * A `btn` rather than daisyUI's `toggle`: it sits in the composer's
 * "how this turn runs" row beside the model, effort, and backend controls,
 * which are all compact buttons, and `aria-pressed` carries the on/off state
 * a `toggle`'s checkbox would.
 */
export function DesignToggle({
  active,
  disabled,
  onToggle,
}: DesignToggleProps) {
  return (
    <button
      aria-pressed={active}
      className={cn("btn btn-ghost btn-xs gap-1", active && "btn-active")}
      disabled={disabled}
      onClick={() => onToggle(!active)}
      title={
        active
          ? "Design mode is on: this message runs several design candidates side by side"
          : "Design mode: run several design candidates side by side"
      }
      type="button"
    >
      <Palette className="h-3.5 w-3.5" />
      Design
    </button>
  );
}
