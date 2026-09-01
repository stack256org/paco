import type { AgentModelSelection } from "@/lib/agent/types";
import { type EffortSelection, parseEffort } from "@/lib/effort";
import { isKnownModelId } from "@/lib/model-catalog";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";

interface ResolveChatModelSelectionParams {
  selectedModelId: string | null | undefined;
  /** Reasoning effort, or null to let the model use its own default. */
  effort?: EffortSelection | undefined;
  label: string;
  /**
   * This instance's configured gateway, if any (`readInstanceSettings().
   * claudeBaseUrl`). Widens the accepted ids to match the gateway's own
   * catalog — without it, a gateway model id the operator actually picked
   * in the composer would fail `isKnownModelId`'s default (static-alias-only)
   * check and be silently replaced with `APP_DEFAULT_MODEL_ID`, exactly the
   * behaviour Settings' gateway section promises does not happen.
   */
  claudeBaseUrl?: string | null;
}

/**
 * Turn a stored model + effort into the flags the CLI is given.
 *
 * Model and effort are separate choices — `--model` and `--effort` are separate
 * flags — so they are stored and resolved separately. They used to be fused
 * into a named "variant" row, which meant a pairing had to be defined before it
 * could be selected, and a deleted row silently downgraded the chat to the
 * default model.
 */
export function resolveChatModelSelection({
  selectedModelId,
  effort,
  label,
  claudeBaseUrl = null,
}: ResolveChatModelSelectionParams): AgentModelSelection {
  const requestedModelId = selectedModelId ?? APP_DEFAULT_MODEL_ID;

  // Checked against the catalog this build actually offers. The previous check
  // matched an `openai/gpt-…-pro` prefix, which no id can have any more, so an
  // unknown model passed straight through to the CLI.
  if (!isKnownModelId(requestedModelId, claudeBaseUrl)) {
    console.warn(
      `${label} "${requestedModelId}" is not a model this build offers. Falling back to the default.`,
    );
    return { id: APP_DEFAULT_MODEL_ID as AgentModelSelection["id"] };
  }

  const resolvedEffort = parseEffort(effort);

  return {
    id: requestedModelId as AgentModelSelection["id"],
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
  };
}
