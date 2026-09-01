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
