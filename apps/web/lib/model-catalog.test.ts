import { describe, expect, mock, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";

mock.module("server-only", () => ({}));

const modulePromise = import("./model-catalog");

function capabilities(
  overrides: Partial<BackendCapabilities>,
): BackendCapabilities {
  return {
    id: "test",
    resume: true,
    steering: "restart",
    mcp: true,
    effort: true,
    subagents: true,
    ...overrides,
  };
}

describe("listAvailableModels", () => {
  /**
   * `undefined` capabilities means "no backend in hand", and the safe answer
   * for an unknown backend is the DEFAULT backend's models — not every id
   * this build knows. Offering a Poolside id to a chat that turns out to run
   * on Claude Code would put a model in the picker the CLI rejects; a caller
   * that really wants every id asks `listAllModels` for it.
   */
  test("with no backend given, offers the default backend's catalog", async () => {
    const { listAvailableModels } = await modulePromise;

    expect(listAvailableModels().map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("a backend that declares no `models` gets the catalog unchanged", async () => {
    const { listAvailableModels } = await modulePromise;

    const models = listAvailableModels(capabilities({ id: "claude-code" }));

    expect(models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  /**
   * The picker used to be Claude-only: it offered opus/sonnet/haiku whatever
   * the chat's backend was, and the chosen id went straight to the second
   * backend as `--model`, which had never heard of a Claude tier alias.
   */
  test("a backend that resolves its own model is offered nothing to pick", async () => {
    const { listAvailableModels } = await modulePromise;

    expect(
      listAvailableModels(capabilities({ id: "other", models: [] })),
    ).toEqual([]);
  });

  test("a backend that names model ids is offered exactly those", async () => {
    const { listAvailableModels } = await modulePromise;

    const models = listAvailableModels(
      capabilities({ models: ["sonnet", "not-in-the-catalog"] }),
    );

    expect(models.map((model) => model.id)).toEqual(["sonnet"]);
  });

  /**
   * The case the previous ACP backend could not produce, and the reason this
   * function filters `ALL_MODELS` rather than the Claude list: Poolside
   * accepts its OWN ids, so filtering a Claude-only catalog by them returned
   * nothing and the picker would have been empty for a backend perfectly
   * willing to take a model.
   */
  test("Poolside's own model ids resolve to real catalog entries", async () => {
    const { listAvailableModels } = await modulePromise;
    const { POOLSIDE_MODEL_IDS } = await import("@paco/poolside-backend");

    const models = listAvailableModels(
      capabilities({ id: "poolside", models: POOLSIDE_MODEL_IDS }),
    );

    expect(models.map((model) => model.id)).toEqual([...POOLSIDE_MODEL_IDS]);
    // Named, not raw ids: the picker renders `name`.
    expect(models.every((model) => model.name.length > 0)).toBe(true);
    // No invented prices. Poolside's rates depend on the deployment
    // `POOLSIDE_STANDALONE_BASE_URL` points at, and a confident wrong figure
    // in the spend estimate is worse than no figure at all.
    expect(models.every((model) => model.cost === undefined)).toBe(true);
  });
});

describe("listAllModels", () => {
  /**
   * The composer's backend selector can switch a chat to Poolside after the
   * page was rendered, and it filters the options it was given client-side.
   * If those options never contained Poolside's ids, the switch would leave
   * an empty picker — so this is the call that must not be narrowed.
   */
  test("spans every backend's ids", async () => {
    const { listAllModels } = await modulePromise;
    const { POOLSIDE_MODEL_IDS } = await import("@paco/poolside-backend");

    const ids = listAllModels().map((model) => model.id);

    expect(ids).toContain("opus");
    for (const id of POOLSIDE_MODEL_IDS) {
      expect(ids).toContain(id);
    }
  });
});

describe("isKnownModelId", () => {
  /**
   * `/api/chat`'s model selection rejects an unknown id. Before Poolside
   * brought its own, "known" and "in the Claude catalog" were the same
   * thing; a Poolside chat's stored `modelId` must not be thrown out by a
   * check that only knows tier aliases.
   */
  test("accepts ids from every backend, and nothing else", async () => {
    const { isKnownModelId } = await modulePromise;
    const { POOLSIDE_MODEL_IDS } = await import("@paco/poolside-backend");

    expect(isKnownModelId("opus")).toBe(true);
    for (const id of POOLSIDE_MODEL_IDS) {
      expect(isKnownModelId(id)).toBe(true);
    }
    expect(isKnownModelId("not-a-model")).toBe(false);
  });
});
