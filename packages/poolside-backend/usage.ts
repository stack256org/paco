import { type TurnUsage, zeroUsage } from "@paco/agent-backend";
import type { PoolsideUsage } from "./acp-types.ts";

/**
 * Token accounting for a Poolside turn.
 *
 * Poolside reports real numbers, which is the substantive difference from
 * OpenFX (whose protocol carried none, so its backend returned zeros
 * forever). They arrive from two places, and both are needed:
 *
 * - the completed `session/prompt` result's `usage`
 *   (`{cachedReadTokens, inputTokens, outputTokens, totalTokens}`), which
 *   is the authoritative end-of-turn total; and
 * - `usage_update` notifications during the turn, whose `_meta` carries
 *   `poolside/inputTokens`, `poolside/outputTokens`,
 *   `poolside/cachedReadTokens` and `poolside/cachedWriteTokens`.
 *
 * The result is preferred, with the last streamed update as the fallback,
 * because a turn ended by `session/cancel` answers with NO `usage` field at
 * all — without the fallback every interrupted or steered turn would report
 * zeros and its tokens would go unbilled in the session log.
 *
 * `cachedWriteTokens` only ever appears on the notification, so a turn's
 * `cacheCreationInputTokens` comes from there even when the result is
 * present.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Reads a `usage_update` notification's counts, or `undefined` for any
 * other update. Live shape:
 * `{sessionUpdate:"usage_update", size, used, _meta:{poolside/inputTokens, ...}}`.
 */
export function readUsageUpdate(update: unknown): PoolsideUsage | undefined {
  if (!isRecord(update) || update.sessionUpdate !== "usage_update") {
    return;
  }
  const meta = update._meta;
  if (!isRecord(meta)) {
    return;
  }
  return {
    inputTokens: numberAt(meta, "poolside/inputTokens"),
    outputTokens: numberAt(meta, "poolside/outputTokens"),
    cachedReadTokens: numberAt(meta, "poolside/cachedReadTokens"),
    cachedWriteTokens: numberAt(meta, "poolside/cachedWriteTokens"),
    // `used` is the context window's occupancy, not a turn total, so it is
    // deliberately not mapped onto `totalTokens`.
  };
}

/**
 * Fold a turn's usage into the neutral `TurnUsage`.
 *
 * `result` is the `session/prompt` response's `usage`; `streamed` is the
 * last `usage_update` seen. Each field takes the result's value when it has
 * one and the streamed value otherwise, so a cancelled turn (result present
 * but usage absent) still reports what the stream observed.
 *
 * `model` populates the per-model breakdown. Poolside never names the model
 * in its usage payloads, so this is the id the turn ASKED for — omitted
 * when the turn took the session's default, rather than guessing.
 */
export function toTurnUsage(
  result: PoolsideUsage | undefined,
  streamed: PoolsideUsage | undefined,
  model?: string,
): TurnUsage {
  if (!(result || streamed)) {
    return zeroUsage();
  }
  const pick = (key: keyof PoolsideUsage): number =>
    result?.[key] ?? streamed?.[key] ?? 0;

  const inputTokens = pick("inputTokens");
  const outputTokens = pick("outputTokens");

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: pick("cachedReadTokens"),
    cacheCreationInputTokens: pick("cachedWriteTokens"),
    // No cost anywhere on the wire — `totalCostUsd` is left unset rather
    // than invented from a token count and a price this package cannot know.
    models: model ? { [model]: { inputTokens, outputTokens } } : {},
  };
}
