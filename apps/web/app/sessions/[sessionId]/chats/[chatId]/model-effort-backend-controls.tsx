import type { BackendCapabilities } from "@paco/agent-backend";
import { EffortSelectorCompact } from "@/components/effort-selector-compact";
import { ModelSelectorCompact } from "@/components/model-selector-compact";
import type { EffortSelection } from "@/lib/effort";
import type { ModelOption } from "@/lib/model-options";
import { cn } from "@/lib/utils";

interface ModelEffortBackendControlsProps {
  modelId: string;
  modelOptions: ModelOption[];
  effort: EffortSelection;
  /**
   * What the chat's *current* backend actually supports — capability-driven
   * UI: the effort control below is hidden whenever `capabilities.effort` is
   * `false`, and the model control whenever `capabilities.models` leaves
   * nothing to choose, rather than this component testing the backend's id
   * against a literal string.
   *
   * That distinction is what makes the row survive a backend swap: a past
   * backend happened to make both controls disappear together, which is
   * exactly the coincidence that makes a hardcoded `backend === "..."`
   * check look correct until a backend comes along that only takes down
   * one of the two. Neither outcome is written down here; both fall out of
   * the object.
   */
  capabilities: BackendCapabilities;
  disabled: boolean;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortSelection) => void;
  onModelCloseAutoFocus?: () => void;
}

/**
 * The composer's "how this turn runs" row: model and reasoning effort, one
 * after another.
 *
 * Extracted out of `session-chat-content.tsx` (already large — see
 * AGENTS.md's file-organization guidance) so the capability-driven hiding
 * rule has one small, directly testable home instead of living inline in a
 * 3000+ line component.
 */
export function ModelEffortBackendControls({
  modelId,
  modelOptions,
  effort,
  capabilities,
  disabled,
  onModelChange,
  onEffortChange,
  onModelCloseAutoFocus,
}: ModelEffortBackendControlsProps) {
  /*
   * The same rule `lib/model-catalog.ts#listAvailableModels` applies on the
   * server, re-applied here because a chat's backend is switched from this
   * very row: `modelOptions` was rendered for whichever backend the page
   * loaded on, and by the time the switch lands it is the wrong list.
   *
   * `capabilities.models` is the backend's own list of accepted ids. A list
   * means exactly those ids and no others; an EMPTY list is the degenerate
   * case of that, not a separate rule — a backend that takes no id from the
   * picker leaves nothing to render and the control disappears on its own.
   *
   * `undefined` DOES NOT mean "show everything", and must never be made to
   * mean that here. It was a safe shorthand for "the whole catalog" only
   * while the catalog was Claude Code's tier aliases and nothing else; a
   * catalog spanning more than one vendor's ids would let it silently offer
   * a model the current backend's CLI rejects. `capabilitiesForBackend`
   * expands `undefined` into the explicit Claude id set before the object
   * crosses to the client, so the branch below is reached only by a backend
   * that genuinely accepts anything on offer.
   */
  const accepted = capabilities.models;
  const visibleModelOptions =
    accepted === undefined
      ? modelOptions
      : modelOptions.filter((option) => accepted.includes(option.id));

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5 border-base-content/10 border-l pl-1.5",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      {visibleModelOptions.length > 0 && (
        <ModelSelectorCompact
          disabled={disabled}
          modelOptions={visibleModelOptions}
          onChange={onModelChange}
          {...(onModelCloseAutoFocus
            ? { onCloseAutoFocus: onModelCloseAutoFocus }
            : {})}
          value={modelId}
        />
      )}
      {capabilities.effort && (
        <EffortSelectorCompact
          disabled={disabled}
          onChange={onEffortChange}
          value={effort}
        />
      )}
    </div>
  );
}
