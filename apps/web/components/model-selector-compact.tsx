"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import type { ModelOption } from "@/lib/model-options";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandList,
} from "@/components/ui/command";
import { ModelOptionList } from "@/components/model-option-list";
import { ProviderIcon } from "@/components/provider-icons";

interface ModelSelectorCompactProps {
  value: string;
  modelOptions: ModelOption[];
  onChange: (modelId: string) => void;
  disabled?: boolean;
  onCloseAutoFocus?: () => void;
}

export function ModelSelectorCompact({
  value,
  modelOptions,
  onChange,
  disabled = false,
  onCloseAutoFocus,
}: ModelSelectorCompactProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.select();
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    focusSearchInput();
  }, [focusSearchInput, open]);

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const isModelShortcut =
        event.metaKey &&
        event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.code === "Slash";

      if (!isModelShortcut || event.repeat) {
        return;
      }

      event.preventDefault();
      setSearch("");
      setOpen(true);
      focusSearchInput();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, focusSearchInput]);

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setSearch("");
    setOpen(false);
  };

  const selectedOption = modelOptions.find((option) => option.id === value);
  /*
   * The value is not one of the options — the chat holds a model this
   * backend does not accept.
   *
   * The row's data is reconciled where it is written (the chat PATCH route
   * moves a stranded `modelId` onto the new backend's default), so this is
   * the belt to that braces: whatever reaches the trigger, it must not read
   * as a working selection. The raw id is still shown rather than nothing —
   * "opus" tells you what is wrong, an empty button does not — but it is
   * shown as a warning, with the provider icon replaced (a Claude glyph
   * beside "opus" on a chat running a different backend is precisely the
   * lie being fixed) and the tooltip saying so.
   */
  const isUnavailableSelection = selectedOption === undefined;
  const displayText = selectedOption?.shortLabel ?? value;
  const triggerTitle = isUnavailableSelection
    ? `${value} isn't available on this backend — pick a model (⌘⌥/)`
    : "Change model (⌘⌥/)";

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setSearch("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          // The warning is carried by colour and an icon, so the accessible
          // name has to carry it too — a screen reader otherwise hears
          // "Change model, opus" and nothing about why it is flagged.
          aria-label={
            isUnavailableSelection
              ? `Change model — ${value} isn't available on this backend`
              : "Change model"
          }
          aria-keyshortcuts="Meta+Alt+/"
          title={triggerTitle}
          className={cn(
            "flex min-w-0 shrink items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-base-content/5 disabled:pointer-events-none disabled:opacity-60",
            isUnavailableSelection
              ? "text-warning hover:text-warning"
              : "text-base-content/60 hover:text-base-content/70",
          )}
        >
          {isUnavailableSelection ? (
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <ProviderIcon
              provider={selectedOption.provider}
              className="size-3.5 shrink-0"
            />
          )}
          <span className="min-w-0 max-w-[140px] truncate">{displayText}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSearchInput();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus?.();
        }}
      >
        <Command>
          <CommandInput
            ref={searchInputRef}
            value={search}
            onValueChange={setSearch}
            placeholder="Search models..."
          />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            <ModelOptionList
              onSelect={handleSelect}
              options={modelOptions}
              value={value}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
