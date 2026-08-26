import type { PermissionHandler } from "./acp-types.ts";

/**
 * The model ids `pool` 1.0.16 accepts, read off a live `session/new`'s
 * `configOptions` entry with id `"model"`.
 *
 * These are NOT Claude tier aliases. Handing `opus`/`sonnet`/`haiku` to
 * Poolside is exactly the mistake OpenFX's `models: []` existed to prevent
 * — the difference being that Poolside really does take a model id, so this
 * backend reports these two rather than refusing the picker outright.
 *
 * `poolside/laguna-s-2.1` is the service default (it carries
 * `_meta["poolside/default"]`): "Our most capable model. Frontier-class
 * reasoning at mid-size cost." `poolside/laguna-xs-2.1` is "Our lightest
 * and fastest agentic coding model."
 *
 * A self-hosted or OpenRouter-backed deployment can offer a different set;
 * `PoolsideBackendConfig.models` overrides this for that case.
 */
export const POOLSIDE_MODEL_IDS: readonly string[] = [
  "poolside/laguna-s-2.1",
  "poolside/laguna-xs-2.1",
];

/** The id `session/new` reports as `currentValue` when nothing is chosen. */
export const POOLSIDE_DEFAULT_MODEL = "poolside/laguna-s-2.1";

/** Poolside's `thought_level` config option — its only reasoning-effort knob. */
export type PoolsideThoughtLevel = "max" | "none";

/**
 * Collapse Paco's five-level effort vocabulary onto Poolside's two.
 *
 * Exported and tested so the mapping lives in exactly one place, but
 * deliberately WITHOUT a caller: `PoolsideBackend.capabilities()` reports
 * `effort: false`, so nothing forwards Paco's effort setting.
 *
 * That is the honest answer rather than a pessimistic one.
 * `BackendCapabilities.effort` is a bare boolean, and the only thing a
 * consumer can do with `true` is render Paco's five-level control and pass
 * on whatever it produces. Against a two-valued knob that means `low` and
 * `medium` both silently become `none` while `high`, `xhigh` and `max` all
 * silently become `max` — four of five levels indistinguishable, with
 * nothing on screen saying so. That is the same defect class as OpenFX
 * declaring `mcp: true` and never receiving a server. The field would need
 * to carry accepted effort values the way it already carries accepted model
 * ids before `true` could be told without misleading someone.
 *
 * This function is what a caller should use if that field ever arrives, or
 * if it deliberately opts into `PoolsideBackendOptions.thoughtLevel`.
 */
const THOUGHT_LEVEL_BY_EFFORT: ReadonlyMap<string, PoolsideThoughtLevel> =
  new Map([
    ["low", "none"],
    ["medium", "none"],
    ["high", "max"],
    ["xhigh", "max"],
    ["max", "max"],
  ]);

export function poolsideThoughtLevel(
  effort: string | undefined,
): PoolsideThoughtLevel | undefined {
  // A miss — unset, or a level from some other vocabulary — yields
  // `undefined`, which means "send no config option at all" and leaves
  // Poolside's own default (`max`) alone rather than guessing at it.
  return effort === undefined ? undefined : THOUGHT_LEVEL_BY_EFFORT.get(effort);
}

/** Constructor options for `PoolsideBackend`. */
export interface PoolsideBackendConfig {
  /** The `pool` binary. Defaults to `"pool"`, resolved on PATH. */
  executable?: string;
  /**
   * Provider/credential environment, layered over `AcpClient`'s minimal
   * base (PATH, HOME, XDG_CONFIG_HOME). See `buildPoolsideBackendConfig`
   * for the two variables that matter.
   */
  env?: Record<string, string>;
  /**
   * Default answer to `session/request_permission` when a turn supplies no
   * `onApprovalRequest`. Defaults to a handler that always denies.
   */
  permissionHandler?: PermissionHandler;
  /** `pool acp --sandbox`. Unset leaves the CLI's own sandbox configuration. */
  sandbox?: "required" | "disabled";
  /** `pool acp --settings` — a YAML file path, or inline YAML. */
  settings?: string;
  /**
   * Extra argv inserted before the `acp` subcommand. Production never sets
   * this; tests point it at `test/stub-pool-acp.ts`.
   */
  extraArgs?: string[];
  /** Forwarded to `AcpClient` — see `AcpClientOptions.closeTimeoutsMs`. */
  closeTimeoutsMs?: { graceful?: number; term?: number };
  /**
   * Overrides the model ids `capabilities()` reports, for a deployment
   * whose catalog differs from the hosted service's. Defaults to
   * `POOLSIDE_MODEL_IDS`.
   */
  models?: readonly string[];
}

/**
 * The stored BYO-provider settings this backend can be built from.
 *
 * Structurally the app's `StoredPoolsideSettings`, declared here so the
 * mapping below can live in the package (and be tested without a database)
 * rather than being re-derived at each call site.
 */
export interface PoolsideProviderSettings {
  /** `null` for Poolside's own hosted service. */
  baseUrl?: string | null;
  apiKey?: string | null;
  /** `null` to find `pool` on PATH. */
  binaryPath?: string | null;
}

/**
 * Map stored Poolside provider settings onto a `PoolsideBackendConfig` —
 * the role `buildOpenFxBackendConfig` played for OpenFX.
 *
 * Every field is load-bearing here, which is the substantive difference
 * from that predecessor. OpenFX accepted an `endpoint`, forwarded it
 * nowhere (no flag or variable could redirect the binary's provider
 * traffic) and so let an operator type a URL into Settings, watch it save,
 * and change nothing. `pool` genuinely reads both variables:
 *
 * - `POOLSIDE_API_KEY` — the credential, in place of the signed-in
 *   `~/.config/poolside/credentials.json`.
 * - `POOLSIDE_STANDALONE_BASE_URL` — the deployment. Verified live:
 *   setting it flips `initialize`'s
 *   `_meta["poolside/service_mode"]` from `"provider: inference.poolside.ai"`
 *   to `"provider: <host>"`. Note it is this variable and NOT
 *   `POOLSIDE_API_URL`, which flips the same field to `"tenant: <host>"` —
 *   a different service mode, reachable but not what "point this at my own
 *   endpoint" means here.
 */
export function buildPoolsideBackendConfig(
  settings: PoolsideProviderSettings,
): PoolsideBackendConfig {
  const env: Record<string, string> = {};
  if (settings.baseUrl) {
    env.POOLSIDE_STANDALONE_BASE_URL = settings.baseUrl;
  }
  if (settings.apiKey) {
    env.POOLSIDE_API_KEY = settings.apiKey;
  }

  return {
    ...(settings.binaryPath ? { executable: settings.binaryPath } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
