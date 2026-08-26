import { describe, expect, test } from "bun:test";
import { readUsageUpdate, toTurnUsage } from "./usage.ts";

/**
 * Both fixtures are verbatim from a live `pool acp` 1.0.16 turn.
 */

/** The `usage` on a COMPLETED `session/prompt` response. */
const RESULT_USAGE = {
  cachedReadTokens: 11_568,
  inputTokens: 23_142,
  outputTokens: 46,
  totalTokens: 23_188,
};

/** The last `usage_update` notification of that same turn. */
const USAGE_UPDATE = {
  _meta: {
    "poolside/cachedReadTokens": 11_568,
    "poolside/cachedWriteTokens": 0,
    "poolside/inputTokens": 23_142,
    "poolside/outputTokens": 46,
  },
  sessionUpdate: "usage_update",
  size: 262_144,
  used: 11_611,
};

describe("readUsageUpdate", () => {
  test("reads the poolside/* counts out of a usage_update's _meta", () => {
    expect(readUsageUpdate(USAGE_UPDATE)).toEqual({
      inputTokens: 23_142,
      outputTokens: 46,
      cachedReadTokens: 11_568,
      cachedWriteTokens: 0,
    });
  });

  test("`used` is context occupancy, not a turn total, so it is not mapped", () => {
    const usage = readUsageUpdate(USAGE_UPDATE);
    expect(usage?.totalTokens).toBeUndefined();
  });

  test("returns undefined for any other update, and for malformed input", () => {
    expect(
      readUsageUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" },
      }),
    ).toBeUndefined();
    expect(readUsageUpdate({ sessionUpdate: "usage_update" })).toBeUndefined();
    expect(readUsageUpdate(null)).toBeUndefined();
  });
});

describe("toTurnUsage", () => {
  test("maps a completed turn's result usage onto TurnUsage", () => {
    expect(toTurnUsage(RESULT_USAGE, undefined)).toEqual({
      inputTokens: 23_142,
      outputTokens: 46,
      cachedInputTokens: 11_568,
      // The result carries no cache-WRITE count; only usage_update does.
      cacheCreationInputTokens: 0,
      models: {},
    });
  });

  test("takes cache writes from the streamed update, which the result never carries", () => {
    const streamed = readUsageUpdate({
      ...USAGE_UPDATE,
      _meta: { ...USAGE_UPDATE._meta, "poolside/cachedWriteTokens": 900 },
    });
    expect(toTurnUsage(RESULT_USAGE, streamed).cacheCreationInputTokens).toBe(
      900,
    );
  });

  test("a cancelled turn has no result usage and falls back to the stream", () => {
    // This is the case that matters: a cancelled `session/prompt` answers
    // with NO `usage` field, so without the fallback every interrupted or
    // steered turn would report zeros and go unbilled in the session log.
    expect(toTurnUsage(undefined, readUsageUpdate(USAGE_UPDATE))).toEqual({
      inputTokens: 23_142,
      outputTokens: 46,
      cachedInputTokens: 11_568,
      cacheCreationInputTokens: 0,
      models: {},
    });
  });

  test("with neither source, returns zeros rather than a partial object", () => {
    expect(toTurnUsage(undefined, undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    });
  });

  test("attributes tokens to the model the turn asked for, when it asked", () => {
    expect(
      toTurnUsage(RESULT_USAGE, undefined, "poolside/laguna-xs-2.1").models,
    ).toEqual({
      "poolside/laguna-xs-2.1": { inputTokens: 23_142, outputTokens: 46 },
    });
    // Poolside never names the model in its usage payloads, so a turn that
    // took the session default gets no breakdown rather than a guess.
    expect(toTurnUsage(RESULT_USAGE, undefined).models).toEqual({});
  });

  test("never reports a cost: nothing on the wire carries one", () => {
    expect(toTurnUsage(RESULT_USAGE, undefined).totalCostUsd).toBeUndefined();
  });
});
