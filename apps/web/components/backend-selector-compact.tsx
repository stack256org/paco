"use client";

import { CheckIcon, ChevronDown, Server } from "lucide-react";
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
import { cn } from "@/lib/utils";

/**
 * `chats.backend`'s enum — see `lib/db/schema.ts` and the `ChatBackendId`
 * this mirrors in `lib/agent/backend-factory.ts`.
 *
 * Declared here rather than imported from there because that module is
 * `server-only`: it constructs the backends themselves. The two are kept in
 * step by `tsc`, since every server boundary a selection crosses (the PATCH
 * route, `capabilitiesForBackend`) is typed in terms of both.
 */
export type ChatBackendSelection = "claude-code" | "poolside";

const BACKEND_LABELS: Record<ChatBackendSelection, string> = {
  "claude-code": "Claude Code",
  poolside: "Poolside",
};

const BACKEND_DESCRIPTIONS: Record<ChatBackendSelection, string> = {
  "claude-code": "Anthropic's CLI agent. Supports reasoning effort.",
  poolside: "Poolside's pool CLI — configured in Settings > Models.",
};

interface BackendSelectorCompactProps {
  value: ChatBackendSelection;
  onChange: (backend: ChatBackendSelection) => void;
  disabled?: boolean;
  onCloseAutoFocus?: () => void;
}

/**
 * Which `AgentBackend` this chat's turns run on.
 *
 * Sits beside the model and effort selectors (same popover/command shape as
 * `EffortSelectorCompact`), rather than folded into `ModelSelectorCompact`'s
 * own list: a chat's backend isn't one of that list's entries — it decides
 * which *kind* of process a model choice even means (Poolside's own model
 * ids are not Claude Code's tier aliases) — and a chat rarely switches
 * backend mid-conversation the way it switches model, so a small, separate
 * control next to it reads more honestly than a cross-product.
 *
 * The list is `BACKEND_LABELS`' keys, so it is exactly the `chats.backend`
 * enum and cannot drift into offering a backend the column would reject.
 */
export function BackendSelectorCompact({
  value,
  onChange,
  disabled = false,
  onCloseAutoFocus,
}: BackendSelectorCompactProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (backend: ChatBackendSelection) => {
    onChange(backend);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Change agent backend"
          title={`Backend: ${BACKEND_LABELS[value]}`}
          className="flex min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-base-content/60 transition-colors hover:bg-base-content/5 hover:text-base-content/70 disabled:pointer-events-none disabled:opacity-60"
        >
          <Server className="size-3.5 shrink-0" />
          <span className="hidden max-w-[110px] truncate @[26rem]:inline">
            {BACKEND_LABELS[value]}
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
            <CommandGroup heading="Agent backend">
              {(Object.keys(BACKEND_LABELS) as ChatBackendSelection[]).map(
                (backend) => (
                  <CommandItem
                    key={backend}
                    value={backend}
                    onSelect={() => handleSelect(backend)}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <div className="flex w-full items-center">
                      <span>{BACKEND_LABELS[backend]}</span>
                      <CheckIcon
                        className={cn(
                          "ml-auto size-4 shrink-0",
                          value === backend ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </div>
                    <span className="text-xs text-base-content/60">
                      {BACKEND_DESCRIPTIONS[backend]}
                    </span>
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
