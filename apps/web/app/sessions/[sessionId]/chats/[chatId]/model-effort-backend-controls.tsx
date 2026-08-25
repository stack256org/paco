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
   * UI (Section 7 Task 5): the effort control below is hidden whenever
   * `capabilities.effort` is `false`, rather than this component checking
   * `backend === "openfx"` itself. A future backend that also lacks effort
   * control hides the same way with no change here.
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
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5 border-base-content/10 border-l pl-1.5",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <ModelSelectorCompact
        disabled={disabled}
        modelOptions={modelOptions}
        onChange={onModelChange}
        {...(onModelCloseAutoFocus
          ? { onCloseAutoFocus: onModelCloseAutoFocus }
          : {})}
        value={modelId}
      />
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
