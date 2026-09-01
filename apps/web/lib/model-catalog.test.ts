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
    compaction: true,
    ...overrides,
  };
}

describe("listAvailableModels", () => {
  /**
   * `undefined` capabilities means "no backend in hand", and the safe answer
   * for an unknown backend is the DEFAULT backend's models — not every id
   * this build knows. A caller that really wants every id asks
   * `listAllModels` for it.
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
   * the chat's backend was, and the chosen id went straight to a second
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
});

describe("listAllModels", () => {
  test("spans the catalog", async () => {
    const { listAllModels } = await modulePromise;

    const ids = listAllModels().map((model) => model.id);

    expect(ids).toEqual(["opus", "sonnet", "haiku"]);
  });
});

describe("isKnownModelId", () => {
  test("accepts a catalog id, and nothing else", async () => {
    const { isKnownModelId } = await modulePromise;

    expect(isKnownModelId("opus")).toBe(true);
    expect(isKnownModelId("not-a-model")).toBe(false);
  });
});

describe("resolveModelIdForBackend", () => {
  /**
   * A chat switching backends used to leave `chats.model_id` holding an id
   * the new backend never heard of, and the composer — which renders the
   * stored id — duly displayed a model the chat's picker didn't even offer.
   */
  test("moves a stranded id onto the new backend's default", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    const resolved = resolveModelIdForBackend(
      capabilities({ id: "claude-code", models: ["opus", "sonnet"] }),
      "haiku",
    );

    // Whatever it is, the backend has to accept it. That is the whole point.
    expect(resolved).toBe("opus");
  });

  test("leaves an id the backend already accepts alone", async () => {
    const { resolveModelIdForBackend } = await modulePromise;

    expect(
      resolveModelIdForBackend(
        capabilities({ id: "claude-code", models: ["sonnet", "haiku"] }),
        "sonnet",
      ),
    ).toBe("sonnet");
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
        "stale-model-id",
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
        "stale-model-id",
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
