import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { APP_DEFAULT_MODEL_ID, type AvailableModel } from "./models";

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
 * The ids of the catalog above.
 *
 * Exported so `capabilitiesForBackend` can expand a backend's
 * `models: undefined` — "the app's own catalog applies unchanged" — into the
 * actual list before that capability object crosses to the client. The
 * composer re-applies the same filter client-side against the options it was
 * handed, and `undefined` there can only mean "show everything".
 */
export const CLAUDE_MODEL_IDS: readonly string[] = CLAUDE_MODELS.map(
  (model) => model.id,
);

/**
 * Every model this build knows about.
 *
 * A separate name from `CLAUDE_MODELS` rather than reused directly: the
 * functions below exist to answer "every model" and "the models a backend
 * accepts" as their own concepts, independent of how many catalogs currently
 * feed them.
 */
const ALL_MODELS: AvailableModel[] = CLAUDE_MODELS;

/**
 * The models offered in the picker for a given backend.
 *
 * `capabilities.models` is the backend's own answer to "which of the
 * picker's ids do I accept": `undefined` means the app's Claude tier aliases
 * apply whole (Claude Code, whose aliases this catalog was originally
 * written in), a list means exactly those ids, and an empty list means the
 * backend resolves its own model and there is nothing to pick.
 *
 * Passing no capabilities at all still answers with the Claude catalog
 * rather than every model this build knows, and that asymmetry is
 * deliberate. `undefined` capabilities means "no backend in hand", and the
 * safe answer for an unknown backend is the default one's models. A caller
 * that genuinely wants every id this build knows about asks for it by name:
 * `listAllModels`.
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
  return ALL_MODELS.filter((model) => accepted.includes(model.id));
}

/**
 * Every model this build knows about.
 *
 * For callers that must not be narrowed to one backend's `capabilities` —
 * any table that resolves a stored `modelId` back to a display name or price
 * regardless of which backend produced it.
 */
export function listAllModels(): AvailableModel[] {
  return ALL_MODELS;
}

/** Whether an id names a model this build actually offers, on any backend. */
export function isKnownModelId(modelId: string): boolean {
  return ALL_MODELS.some((model) => model.id === modelId);
}

/**
 * The `modelId` a chat should hold once it is running on this backend.
 *
 * A chat switching backends used to leave `chats.model_id` alone, which is
 * how a chat could end up storing an id its current backend does not accept.
 * The turn itself was fine — `run-step.ts`'s `resolveModelId` refuses to
 * forward an id the backend does not accept — but the composer read the row
 * and showed a model name the chat could not actually run. Rather than teach
 * the trigger to hide that, the row stops holding it.
 *
 * What it becomes is the new backend's DEFAULT, never `null`:
 *
 * - `null` would be the honest "the backend decides" value, and `run-step`
 *   would handle it correctly, but the composer renders its whole
 *   model/effort/backend row behind `chatInfo.modelId &&`. Clearing the id
 *   takes the BACKEND selector down with the model one, stranding the chat
 *   on the backend it was just switched to with no control left to switch
 *   back. A default is also the truthful answer: the backend does resolve a
 *   model when handed none, and naming it is what lets the picker show a tick.
 * - The default is `APP_DEFAULT_MODEL_ID` when the backend accepts it, so a
 *   chat lands on `opus` rather than on whatever sorted first; otherwise the
 *   first model the PICKER offers for that backend — the top of the list the
 *   person is looking at. So the picker agrees with the service default.
 * - A backend that offers nothing to pick keeps whatever the row held. There
 *   is no id to move it to, and clearing it would hide the composer row for
 *   the reason above. Nothing displays the stale value in that case: the
 *   picker is not rendered at all.
 *
 * An id the backend already accepts is returned untouched, so this is safe
 * to call on every write.
 */
export function resolveModelIdForBackend(
  capabilities: Pick<BackendCapabilities, "models"> | undefined,
  currentModelId: string | null | undefined,
): string | null {
  const offered = listAvailableModels(capabilities);
  if (currentModelId && offered.some((model) => model.id === currentModelId)) {
    return currentModelId;
  }
  if (offered.length === 0) {
    return currentModelId ?? null;
  }
  const appDefault = offered.find(
    (model) => model.id === APP_DEFAULT_MODEL_ID,
  )?.id;
  return appDefault ?? offered[0]?.id ?? currentModelId ?? null;
}
