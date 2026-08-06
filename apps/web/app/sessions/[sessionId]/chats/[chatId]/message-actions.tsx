"use client";

import { Check, Copy, Loader2, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useId } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type MessageAction = {
  /** The menu label. A verb phrase, because it is what the item will do. */
  label: string;
  icon: ReactNode;
  /** Named `handleSelect` so it reads as the click handler it becomes. */
  handleSelect: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Renders in the error colour and sits below a separator. */
  destructive?: boolean;
  /** One line under the label, for anything that is not obvious from it. */
  hint?: string;
};

/**
 * The row of actions under one message.
 *
 * Three things were wrong with the rows this replaces, and all three came from
 * treating these as decoration rather than controls.
 *
 * They were positioned outside the message — the user row sat at `-left-20`,
 * five rem to the left of a bubble that is itself right-aligned. That is fine
 * in a wide window and lands off the edge of a conversation pane docked at a
 * quarter of the screen, which is the width this pane is designed for.
 *
 * They were revealed by `group-hover` alone, so a keyboard could focus a button
 * that was still at `opacity-0`: invisible focus, on a control that deletes
 * messages. Hover *and* focus-within reveal them now.
 *
 * And every action was a bare icon of equal weight, so "copy this text" and
 * "delete this message and everything after it" looked identical and sat a few
 * pixels apart. The common, safe action stays visible; everything rarer —
 * including everything destructive — moves behind one labelled menu, where the
 * items have words rather than glyphs.
 */
export function MessageActions({
  actions,
  align = "start",
  className,
  copyLabel = "Copy this message",
  copied,
  onCopy,
  trailing,
}: {
  /** Secondary actions. They live in the menu, in the order given. */
  actions: MessageAction[];
  align?: "start" | "end";
  className?: string;
  copyLabel?: string;
  copied?: boolean;
  /** Omit to leave copy out entirely — not every message has text to copy. */
  onCopy?: () => void;
  /** Rendered after the menu, e.g. the model pill. */
  trailing?: ReactNode;
}) {
  const menuId = useId();
  const available = actions.filter((action) => !action.disabled);
  const hasMenu = available.length > 0;

  if (!(hasMenu || onCopy || trailing)) {
    return null;
  }

  const [ordinary, destructive] = [
    available.filter((action) => !action.destructive),
    available.filter((action) => action.destructive),
  ];

  return (
    <div
      className={cn(
        // Hidden until the message is hovered or something inside it has focus.
        // `focus-within` is the half that was missing: without it these are
        // unreachable by keyboard, which for a delete action is not a
        // cosmetic problem.
        "flex items-center gap-0.5 opacity-0 transition-opacity duration-150",
        "group-hover:opacity-100 group-focus-within:opacity-100",
        align === "end" && "justify-end",
        className,
      )}
    >
      {onCopy ? (
        <button
          aria-label={copied ? "Copied" : copyLabel}
          className="btn btn-ghost btn-xs px-1.5 text-base-content/60 hover:text-base-content"
          onClick={onCopy}
          type="button"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </button>
      ) : null}

      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More actions for this message"
            className="btn btn-ghost btn-xs px-1.5 text-base-content/60 hover:text-base-content"
            id={menuId}
          >
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align} className="w-60">
            {ordinary.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onClick={action.handleSelect}
              >
                {action.busy ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  action.icon
                )}
                <span className="flex min-w-0 flex-col">
                  <span>{action.label}</span>
                  {action.hint ? (
                    <span className="text-base-content/60 text-xs">
                      {action.hint}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))}

            {ordinary.length > 0 && destructive.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}

            {destructive.map((action) => (
              <DropdownMenuItem
                className="text-error"
                key={action.label}
                onClick={action.handleSelect}
              >
                {action.busy ? (
                  <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  action.icon
                )}
                <span className="flex min-w-0 flex-col">
                  <span>{action.label}</span>
                  {action.hint ? (
                    <span className="text-error/70 text-xs">{action.hint}</span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {trailing}
    </div>
  );
}
