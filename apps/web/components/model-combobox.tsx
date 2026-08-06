"use client";

import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ProviderIcon,
  getProviderFromModelId,
  getProviderDisplayName,
  stripProviderPrefix,
} from "@/components/provider-icons";

interface ModelComboboxItem {
  id: string;
  label: string;
  description?: string;
  provider?: string;
}

interface ModelComboboxProps {
  value: string;
  items: ModelComboboxItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Lands on the trigger, so a `<label htmlFor>` outside this component binds
   * to the control the user actually clicks. Without it the label pointed at
   * nothing and the combobox had no accessible name.
   */
  id?: string;
  onChange: (value: string) => void;
}

/** Providers pinned to the top. */
const PRIORITY_PROVIDERS = ["anthropic", "openai"];

function groupByProvider(items: ModelComboboxItem[]) {
  const groups: Record<string, ModelComboboxItem[]> = {};
  const providers: string[] = [];
  for (const item of items) {
    const provider = item.provider ?? getProviderFromModelId(item.id);
    if (!groups[provider]) {
      groups[provider] = [];
      providers.push(provider);
    }
    groups[provider].push(item);
  }

  providers.sort((a, b) => {
    const aIdx = PRIORITY_PROVIDERS.indexOf(a);
    const bIdx = PRIORITY_PROVIDERS.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  return providers.map((provider) => ({
    provider,
    label: getProviderDisplayName(provider),
    options: groups[provider],
  }));
}

export function ModelCombobox({
  value,
  items,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  disabled = false,
  className,
  id,
  onChange,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedItem = items.find((item) => item.id === value);
  const selectedProvider =
    selectedItem?.provider ??
    (selectedItem ? getProviderFromModelId(selectedItem.id) : undefined);
  const displayText = selectedItem
    ? stripProviderPrefix(selectedItem.label, selectedProvider ?? "")
    : placeholder;

  const groups = useMemo(() => groupByProvider(items), [items]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={cn(
            "border-base-300 data-[placeholder]:text-base-content/60 [&_svg:not([class*='text-'])]:text-base-content/60 focus-visible:border-ring focus-visible:ring-primary/50 flex h-9 w-full max-w-xs items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedProvider && (
              <ProviderIcon
                provider={selectedProvider}
                className="size-3.5 shrink-0"
              />
            )}
            <span className="truncate text-left">{displayText}</span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command>
          {/* The placeholder is the only visible hint, and a placeholder is
              not an accessible name — name the field outright. */}
          <CommandInput
            aria-label="Search models"
            placeholder={searchPlaceholder}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.provider} heading={group.label}>
                {group.options.map((item) => {
                  const provider =
                    item.provider ?? getProviderFromModelId(item.id);
                  const shortLabel = stripProviderPrefix(item.label, provider);
                  return (
                    <CommandItem
                      key={item.id}
                      value={`${item.label} ${item.id}`}
                      onSelect={() => {
                        onChange(item.id);
                        setOpen(false);
                      }}
                      className="flex items-center"
                    >
                      <ProviderIcon
                        provider={provider}
                        className="mr-1.5 size-3.5 shrink-0 opacity-70"
                      />
                      <span className="min-w-0 truncate">{shortLabel}</span>
                      <CheckIcon
                        className={cn(
                          "ml-auto size-4 shrink-0",
                          value === item.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
