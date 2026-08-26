import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { POOLSIDE_MODEL_IDS } from "@paco/poolside-backend";
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
 * composer re-applies the same filter client-side against options it was
 * handed for a different backend, and `undefined` there can only mean "show
 * everything", which stopped being the right answer the moment a second
 * vendor's ids joined the catalog.
 */
export const CLAUDE_MODEL_IDS: readonly string[] = CLAUDE_MODELS.map(
  (model) => model.id,
);

/**
 * Models offered in the picker for a Poolside chat.
 *
 * A separate block rather than more entries in the list above, because these
 * are not tier aliases resolved by a CLI: they are the concrete model ids
 * Poolside's ACP session accepts for its `model` config option, and the two
 * catalogs share no id.
 *
 * The LIST is `POOLSIDE_MODEL_IDS` — the same constant
 * `PoolsideBackend.capabilities().models` is built from — and only the
 * display copy lives here. An id in the backend's list but not the picker's
 * is exactly how a picker ends up hiding a model the backend accepts, so the
 * ids are read from one place and the copy degrades to the raw id rather
 * than the entry disappearing.
 *
 * No `cost`, deliberately. The Claude entries carry published per-million
 * rates because there are published per-million rates; Poolside's are a
 * function of whatever deployment `POOLSIDE_STANDALONE_BASE_URL` points at,
 * and inventing numbers here would put a confident, wrong figure in the
 * spend estimate. `estimateModelUsageCost` already returns `undefined` for a
 * model with no cost tier, so the estimate omits these turns rather than
 * mispricing them.
 *
 * There is no `context_window` either, for the same reason: it is
 * deployment-dependent and not reported over the handshake.
 */
const POOLSIDE_MODEL_COPY: Record<
  string,
  { name: string; description: string }
> = {
  "poolside/laguna-s-2.1": {
    name: "Laguna S",
    description:
      "Poolside's most capable model. Frontier-class reasoning at mid-size cost.",
  },
  "poolside/laguna-xs-2.1": {
    name: "Laguna XS",
    description: "Poolside's lightest and fastest agentic coding model.",
  },
};

const POOLSIDE_MODELS: AvailableModel[] = POOLSIDE_MODEL_IDS.map((id) => ({
  id,
  // An id with no copy yet still reaches the picker, labelled by its id.
  // The alternative — filtering it out — would make a model the backend
  // accepts silently unpickable, which is the failure this whole file is
  // being rewritten to stop.
  name: POOLSIDE_MODEL_COPY[id]?.name ?? id,
  ...(POOLSIDE_MODEL_COPY[id]
    ? { description: POOLSIDE_MODEL_COPY[id]?.description }
    : {}),
  modelType: "language",
}));

/**
 * Every model this build knows about, across every backend.
 *
 * The filter below reads from this rather than from `CLAUDE_MODELS`, which
 * is what makes `capabilities.models` a real selector instead of a
 * Claude-only allowlist. It mattered the moment a second backend brought its
 * own ids: filtering the Claude list by Poolside's ids returns nothing, so a
 * Poolside chat would have shown an empty picker while the backend was
 * perfectly willing to take a model.
 */
const ALL_MODELS: AvailableModel[] = [...CLAUDE_MODELS, ...POOLSIDE_MODELS];

/**
 * The models offered in the picker for a given backend.
 *
 * `capabilities.models` is each backend's own answer to "which of the
 * picker's ids do I accept": `undefined` means the app's Claude tier aliases
 * apply whole (Claude Code, whose aliases this catalog was originally
 * written in), a list means exactly those ids — Poolside names its two
 * `poolside/laguna-*` models, which is the case that makes this a selector
 * across catalogs rather than a filter on one — and an empty list means the
 * backend resolves its own model and there is nothing to pick.
 *
 * Passing no capabilities at all still answers with the Claude catalog
 * rather than every model this build knows, and that asymmetry is
 * deliberate. `undefined` capabilities means "no backend in hand", and the
 * safe answer for an unknown backend is the default one's models — handing
 * back a Poolside id for a chat that turns out to run on Claude Code would
 * put a model in the picker the CLI rejects. A caller that genuinely wants
 * every id across every backend asks for it by name: `listAllModels`.
 *
 * The composer applies this same rule client-side against
 * `ModelOption[]` — see `ModelEffortBackendControls` — because a chat's
 * backend can be switched after this page was rendered. For that filter to
 * be able to reveal Poolside's models on a switch, the options it is given
 * have to have come from `listAllModels`.
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
 * Every model this build knows about, across every backend.
 *
 * For the two callers that must not be narrowed to one backend: the
 * composer, whose backend selector can switch a chat to Poolside after the
 * page was rendered (so the options it filters client-side have to already
 * contain Poolside's ids), and any table that resolves a stored `modelId`
 * back to a display name or price regardless of which backend produced it.
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
 * Switching a chat's backend used to leave `chats.model_id` alone, so a chat
 * moved to Poolside still stored `opus`. The turn itself was fine —
 * `run-step.ts`'s `resolveModelId` refuses to forward an id the backend does
 * not accept — but the composer read the row and showed "opus" on a chat
 * that could only run Laguna. Rather than teach the trigger to hide that,
 * the row stops holding it.
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
 *   chat coming back to Claude Code lands on `opus` rather than on whatever
 *   sorted first; otherwise the first model the PICKER offers for that
 *   backend — the top of the list the person is looking at, which for
 *   Poolside is `poolside/laguna-s-2.1`, the same id `pool` reports as its
 *   own `currentValue`. So the picker agrees with the service default.
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
