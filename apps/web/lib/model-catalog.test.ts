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
    images: true,
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

describe("resolveModelIdForBackend", () => {
  /**
   * Bug 1's data half. Switching a chat to Poolside used to leave
   * `chats.model_id` holding `opus`, and the composer — which renders the
   * stored id — duly said "opus" on a chat whose picker offered nothing but
   * Laguna.
   */
  test("moves a stranded id onto the new backend's default", async () => {
    const { resolveModelIdForBackend } = await modulePromise;
    const { POOLSIDE_MODEL_IDS, POOLSIDE_DEFAULT_MODEL } =
      await import("@paco/poolside-backend");

    const resolved = resolveModelIdForBackend(
      capabilities({ id: "poolside", models: POOLSIDE_MODEL_IDS }),
      "opus",
    );

    expect(resolved).toBe(POOLSIDE_DEFAULT_MODEL);
    // Whatever it is, the backend has to accept it. That is the whole point.
    expect(POOLSIDE_MODEL_IDS).toContain(resolved as string);
  });

  test("leaves an id the backend already accepts alone", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(
        capabilities({ id: "poolside", models: ["poolside/laguna-xs-2.1"] }),
        "poolside/laguna-xs-2.1",
      ),
    ).toBe("poolside/laguna-xs-2.1");
    expect(
      resolveModelIdForBackend(capabilities({ id: "claude-code" }), "sonnet"),
    ).toBe("sonnet");
  });

  /**
   * Coming back the other way. `APP_DEFAULT_MODEL_ID` wins whenever the
   * backend accepts it, so a chat returning to Claude Code lands on the model
   * a new chat would start on rather than on whatever happens to sort first.
   */
  test("prefers the app default when the backend accepts it", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(
        capabilities({ id: "claude-code" }),
        "poolside/laguna-s-2.1",
      ),
    ).toBe("opus");
  });

  /**
   * "First" is the first the PICKER offers — catalog order, which is the top
   * of the list the person is looking at — not the order the backend happened
   * to list its accepted ids in.
   */
  test("falls back to the first offered model when the app default is not on offer", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(
        capabilities({ id: "claude-code", models: ["haiku", "sonnet"] }),
        "poolside/laguna-s-2.1",
      ),
    ).toBe("sonnet");
  });

  /**
   * Never `null` while there is something to pick — the composer hides its
   * whole model/effort/backend row behind `chatInfo.modelId &&`, so clearing
   * the id would take the backend selector down with it and strand the chat
   * on the backend it was just switched to.
   */
  test("fills in a null model id for a backend that offers models", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(capabilities({ id: "claude-code" }), null),
    ).toBe("opus");
  });

  /**
   * A backend that resolves its own model has no id to move the row onto, and
   * clearing it would hide the composer row for the reason above. Nothing
   * renders the stale value in that case: the picker is not shown at all.
   */
  test("keeps the stored id when the backend offers nothing to pick", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(
        capabilities({ id: "other", models: [] }),
        "opus",
      ),
    ).toBe("opus");
    expect(
      resolveModelIdForBackend(capabilities({ id: "other", models: [] }), null),
    ).toBeNull();
  });
});
