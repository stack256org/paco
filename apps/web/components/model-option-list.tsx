"use client";

import { CheckIcon } from "lucide-react";
import { useMemo } from "react";
import { ProviderIcon } from "@/components/provider-icons";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import type { ModelOption } from "@/lib/model-options";
import { groupModelsByProvider } from "@/lib/model-provider-groups";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { cn } from "@/lib/utils";

interface ModelOptionListProps {
  options: ModelOption[];
  /** The currently stored model id — ticked when it is one of `options`. */
  value: string;
  onSelect: (modelId: string) => void;
}

/**
 * The composer model picker's list: one `CommandGroup` per provider.
 *
 * Its own file, and not inlined in `ModelSelectorCompact`, for two reasons.
 * The heading used to be a hardcoded `"Anthropic"` above every model in the
 * catalog — so a Poolside chat filed `poolside/laguna-*` under Anthropic —
 * and a rule with a bug in it deserves somewhere it can be rendered on its
 * own. Which is the second reason: the list lives inside a popover that only
 * mounts on open, so as long as it was inline no test and no screenshot could
 * see it. This component renders under a plain `<Command>`.
 */
export function ModelOptionList({
  options,
  value,
  onSelect,
}: ModelOptionListProps) {
  const groups = useMemo(() => groupModelsByProvider(options), [options]);

  return (
    <>
      {groups.map((group) => (
        <CommandGroup heading={group.label} key={group.provider}>
          {group.options.map((option) => (
            <CommandItem
              className="flex items-center"
              key={option.id}
              onSelect={() => onSelect(option.id)}
              value={`${option.label} ${option.id}`}
            >
              <ProviderIcon
                className="mr-1.5 size-3.5 shrink-0 opacity-70"
                provider={option.provider}
              />
              <span className="min-w-0 truncate">{option.shortLabel}</span>
              {/*
                The app's own starting model, not the group's. It is a Claude
                tier alias, so a Poolside chat's list carries no "default"
                marker at all — which is the honest answer: Paco has no
                opinion about which Laguna a new chat should use, `pool`
                does.
              */}
              {option.id === APP_DEFAULT_MODEL_ID && (
                <span className="ml-auto shrink-0 text-base-content/60 text-xs">
                  default
                </span>
              )}
              <CheckIcon
                className={cn(
                  "ml-auto size-4 shrink-0",
                  value === option.id ? "opacity-100" : "opacity-0",
                )}
              />
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </>
  );
}
