import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import type { AvailableModel } from "./models";

/**
 * Models offered in the picker.
 *
 * Model selection is resolved by the Claude Code CLI, which takes a tier alias
 * and maps it to the current model in that tier. There is no catalog to fetch:
 * the list is static, the aliases never go stale, and rendering the picker
 * needs no network call.
 *
 * Costs are the published per-million-token rates and only drive the UI's
 * spend estimate. The authoritative figure is the `total_cost_usd` the CLI
 * reports for each run.
 */
const CLAUDE_MODELS: AvailableModel[] = [
  {
    id: "opus",
    name: "Opus",
    description:
      "Highest capability. Best for planning, orchestration, and hard multi-file work.",
    modelType: "language",
    context_window: 1_000_000,
    cost: { input: 5, output: 25, cache_read: 0.5 },
  },
  {
    id: "sonnet",
    name: "Sonnet",
    description:
      "Balanced speed and capability. The default for most implementation work.",
    modelType: "language",
    context_window: 1_000_000,
    cost: { input: 3, output: 15, cache_read: 0.3 },
  },
  {
    id: "haiku",
    name: "Haiku",
    description:
      "Fastest and cheapest. Best for exploration, search, and short tasks.",
    modelType: "language",
    context_window: 200_000,
    cost: { input: 1, output: 5, cache_read: 0.1 },
  },
];

/**
 * The models offered in the picker for a given backend.
 *
 * The catalog above is written in Claude Code's tier aliases, so it is only
 * the right answer for a backend that accepts them. `capabilities.models` is
 * each backend's own answer to that: `undefined` means the whole catalog
 * applies (Claude Code), a list means exactly those ids, and an empty list
 * means the backend resolves its own model and there is nothing to pick —
 * OpenFX, whose binary takes its model from its own config
 * (`OpenFxBackend.capabilities()`). Passing no capabilities at all keeps the
 * catalog whole, for callers with no backend in hand (the spend estimate's
 * cost table, which just needs every price it knows).
 *
 * The composer applies this same rule client-side against
 * `ModelOption[]` — see `ModelEffortBackendControls` — because a chat's
 * backend can be switched after this page was rendered.
 *
 * Synchronous on purpose: nothing is fetched. It reads as an odd shape for a
 * "catalog", which is precisely why it should not pretend to be async.
 */
export function listAvailableModels(
  capabilities?: Pick<BackendCapabilities, "models">,
): AvailableModel[] {
  const accepted = capabilities?.models;
  if (accepted === undefined) {
    return CLAUDE_MODELS;
  }
  return CLAUDE_MODELS.filter((model) => accepted.includes(model.id));
}

/** Whether an id names a model this build actually offers. */
export function isKnownModelId(modelId: string): boolean {
  return CLAUDE_MODELS.some((model) => model.id === modelId);
}
