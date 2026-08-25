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
  test("with no backend given, offers the app's own catalog", async () => {
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
   * the chat's backend was, and the chosen id went straight to OpenFX as
   * `--model`, which has never heard of a Claude tier alias.
   */
  test("a backend that resolves its own model is offered nothing to pick", async () => {
    const { listAvailableModels } = await modulePromise;

    expect(
      listAvailableModels(capabilities({ id: "openfx", models: [] })),
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
