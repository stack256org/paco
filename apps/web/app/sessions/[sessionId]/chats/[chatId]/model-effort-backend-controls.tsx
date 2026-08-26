import type { BackendCapabilities } from "@paco/agent-backend";
import {
  type ChatBackendSelection,
  BackendSelectorCompact,
} from "@/components/backend-selector-compact";
import { EffortSelectorCompact } from "@/components/effort-selector-compact";
import { ModelSelectorCompact } from "@/components/model-selector-compact";
import type { EffortSelection } from "@/lib/effort";
import type { ModelOption } from "@/lib/model-options";
import { cn } from "@/lib/utils";

interface ModelEffortBackendControlsProps {
  modelId: string;
  modelOptions: ModelOption[];
  effort: EffortSelection;
  backend: ChatBackendSelection;
  /**
   * What the chat's *current* backend actually supports — capability-driven
   * UI: the effort control below is hidden whenever `capabilities.effort` is
   * `false`, and the model control whenever `capabilities.models` leaves
   * nothing to choose, rather than this component testing the `backend` prop
   * against a literal id.
   *
   * That distinction is what makes the row survive a backend swap. Under
   * OpenFX both controls happened to disappear together, so a
   * `backend === "openfx"` check would have looked correct; Poolside splits
   * them — it publishes its own model list through `session/new`'s
   * `configOptions`, so the model picker STAYS, while its only
   * reasoning knob is a two-valued `thought_level` that does not map onto
   * Paco's effort levels, so the effort control still goes. Neither outcome
   * is written down here; both fall out of the object.
   */
  capabilities: BackendCapabilities;
  disabled: boolean;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: EffortSelection) => void;
  onBackendChange: (backend: ChatBackendSelection) => void;
  onModelCloseAutoFocus?: () => void;
}

/**
 * The composer's "how this turn runs" row: model, reasoning effort, and
 * agent backend, one after another.
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
  backend,
  capabilities,
  disabled,
  onModelChange,
  onEffortChange,
  onBackendChange,
  onModelCloseAutoFocus,
}: ModelEffortBackendControlsProps) {
  /*
   * The same rule `lib/model-catalog.ts#listAvailableModels` applies on the
   * server, re-applied here because a chat's backend is switched from this
   * very row: `modelOptions` was rendered for whichever backend the page
   * loaded on. `capabilities.models` is the backend's own list of accepted
   * ids — `undefined` means the whole catalog applies (Claude Code, whose
   * tier aliases the catalog is written in), and a list means exactly those
   * ids and no others. An EMPTY list is the degenerate case of that, not a
   * separate rule: a backend that takes no id from the picker leaves nothing
   * to render and the control disappears on its own.
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
      <BackendSelectorCompact
        disabled={disabled}
        onChange={onBackendChange}
        value={backend}
      />
    </div>
  );
}
