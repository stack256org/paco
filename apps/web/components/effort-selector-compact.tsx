"use client";

import { CheckIcon, ChevronDown, Gauge } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { type Effort, EFFORT_LEVELS, type EffortSelection } from "@/lib/effort";
import { cn } from "@/lib/utils";

/*
 * Plain names for the five effort levels the CLI accepts.
 *
 * `lib/effort.ts` keeps the wire values ("low", "xhigh") and the labels the
 * flags are named after; those are the right words for the flag and the wrong
 * words in a composer, where the question is really "how long should this
 * take?". The levels themselves are unchanged — only what they are called
 * here.
 */
const PLAIN_EFFORT_LABELS: Record<Effort, string> = {
  low: "Quick",
  medium: "Balanced",
  high: "Thorough",
  xhigh: "Very thorough",
  max: "Take as long as it needs",
};

const PLAIN_EFFORT_DESCRIPTIONS: Record<Effort, string> = {
  low: "Answers fast. Good for a small change you have already thought through.",
  medium: "A sensible middle ground for everyday work.",
  high: "Thinks it over first. Good for tricky bugs and design decisions.",
  xhigh: "Thinks a lot harder, and takes noticeably longer.",
  max: "As much thinking as it can do. Slow, and the most expensive.",
};

const AUTOMATIC_LABEL = "Automatic";

function plainEffortLabel(effort: EffortSelection): string {
  return effort ? PLAIN_EFFORT_LABELS[effort] : AUTOMATIC_LABEL;
}

interface EffortSelectorCompactProps {
  value: EffortSelection;
  onChange: (effort: EffortSelection) => void;
  disabled?: boolean;
  onCloseAutoFocus?: () => void;
}

/**
 * How hard the model should think, independent of which model it is.
 *
 * Sits beside the model picker rather than inside it. Folding the two together
 * made the list a cross-product where only the combinations someone had named
 * in advance existed.
 */
export function EffortSelectorCompact({
  value,
  onChange,
  disabled = false,
  onCloseAutoFocus,
}: EffortSelectorCompactProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (effort: EffortSelection) => {
    onChange(effort);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Change how hard Paco thinks"
          title={`How hard to think: ${plainEffortLabel(value)}`}
          className="flex min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-base-content/60 transition-colors hover:bg-base-content/5 hover:text-base-content/70 disabled:pointer-events-none disabled:opacity-60"
        >
          <Gauge className="size-3.5 shrink-0" />
          {/*
            Hidden in a narrow container, where this row has to fit an attach
            button, a microphone, a model name, this control, a usage ring and
            Send inside a pane the user can drag to a quarter of the window.
            The gauge icon and the accessible name both survive; only the word
            goes. A container query, because the pane can be narrow in a wide
            window.
          */}
          <span className="hidden max-w-[110px] truncate @[26rem]:inline">
            {plainEffortLabel(value)}
          </span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus?.();
        }}
      >
        <Command>
          <CommandList>
            <CommandGroup heading="How hard to think">
              <CommandItem
                value="default"
                onSelect={() => handleSelect(null)}
                className="flex flex-col items-start gap-0.5"
              >
                <div className="flex w-full items-center">
                  <span>{AUTOMATIC_LABEL}</span>
                  <CheckIcon
                    className={cn(
                      "ml-auto size-4 shrink-0",
                      value === null ? "opacity-100" : "opacity-0",
                    )}
                  />
                </div>
                <span className="text-xs text-base-content/60">
                  Let the AI decide for itself.
                </span>
              </CommandItem>

              {EFFORT_LEVELS.map((effort) => (
                <CommandItem
                  key={effort}
                  value={effort}
                  onSelect={() => handleSelect(effort)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <div className="flex w-full items-center">
                    <span>{PLAIN_EFFORT_LABELS[effort]}</span>
                    <CheckIcon
                      className={cn(
                        "ml-auto size-4 shrink-0",
                        value === effort ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </div>
                  <span className="text-xs text-base-content/60">
                    {PLAIN_EFFORT_DESCRIPTIONS[effort]}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
