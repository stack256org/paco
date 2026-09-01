import "server-only";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface GatewayModelCacheEntry {
  id: string;
  display_name?: string;
}

/**
 * Where the CLI caches a gateway's model list, after the `/v1/models`
 * discovery request it runs itself
 * (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, set in
 * `lib/agent/run-step.ts`'s `claudeGatewayEnv`).
 *
 * This is **not** `PACO_HOME`. That variable (`lib/memory/paths.ts`'s
 * `dataDir()`) is Paco's own data directory — the root for memory and
 * installed plugins, documented in `docs/self-hosting.md` as an operator
 * override — and has nothing to do with where the `claude` CLI keeps its
 * config. The packaged install does not even set `PACO_HOME`: `postinst`
 * never writes it into `paco.env`, and `paco-entrypoint.sh` assigns it as a
 * plain shell variable without exporting it, so it never reaches the server
 * process's environment there either. The CLI's cache lives under its own
 * `$HOME`, which is whatever `HOME` the server process itself runs with —
 * `child-env.ts` passes that value through to the spawned CLI unchanged.
 * Using `PACO_HOME` here would have been right only by the accident of it
 * usually being unset; an operator who *does* set it (to relocate memory or
 * plugins, exactly as documented) would silently point this function at a
 * directory the CLI never writes to, and the picker would fall back to the
 * static aliases forever.
 */
function gatewayModelCachePath(): string {
  return join(
    process.env.HOME ?? homedir(),
    ".claude",
    "cache",
    "gateway-models.json",
  );
}

/**
 * Parse the CLI's discovery cache into this app's model shape.
 *
 * Returns `null` — never an empty array — for anything short of a file that
 * parses into the documented `{"data": [...]}` shape, so the caller has one
 * place to decide "fall back to the static aliases" instead of two (a
 * missing file, and a file present but unreadable or malformed).
 */
function readGatewayModelCache(): AvailableModel[] | null {
  let raw: string;
  try {
    raw = readFileSync(gatewayModelCachePath(), "utf-8");
  } catch {
    // Absent, or unreadable (permissions, not-yet-created directory) — the
    // gateway simply hasn't been queried yet.
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (!Array.isArray(parsed.data)) {
      return null;
    }
    return (parsed.data as GatewayModelCacheEntry[]).map((entry) => ({
      id: entry.id,
      name: entry.display_name ?? entry.id,
      modelType: "language",
    }));
  } catch {
    return null;
  }
}

/**
 * The models to offer when talking to Claude, reflecting this instance's
 * own gateway configuration.
 *
 * `baseUrl` null means Anthropic direct, so this returns the static tier
 * aliases above unchanged. A configured base URL switches to the CLI's own
 * discovery cache, falling back to the aliases when that cache is absent or
 * unreadable — a gateway an operator just configured, and that the CLI has
 * not queried yet, must not leave the picker with nothing to choose.
 */
export function listClaudeModels(baseUrl: string | null): AvailableModel[] {
  if (baseUrl === null) {
    return CLAUDE_MODELS;
  }
  return readGatewayModelCache() ?? CLAUDE_MODELS;
}

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
 * that genuinely wants every id this build knows about, regardless of any
 * backend's `capabilities`, calls `listClaudeModels(null)` directly — with
 * no base URL that already returns exactly this same static catalog.
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
 * Whether an id names a model this build actually offers, on any backend.
 *
 * `claudeBaseUrl` widens the accepted set to match what the picker actually
 * shows: with a gateway configured, `listClaudeModels` returns that
 * gateway's own ids (from the CLI's discovery cache) instead of the static
 * tier aliases, and a gateway model id an operator picked must not be
 * rejected here and silently replaced with the default — the exact failure
 * `app/api/chat/_lib/model-selection.ts` exists to avoid. Omitted (or
 * `null`), this checks only the static aliases, which is also what
 * `listClaudeModels(null)` returns — so passing `null` explicitly and
 * omitting the argument answer identically.
 */
export function isKnownModelId(
  modelId: string,
  claudeBaseUrl: string | null = null,
): boolean {
  return listClaudeModels(claudeBaseUrl).some((model) => model.id === modelId);
}
