import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
   * this build knows. A caller that really wants every id calls
   * `listClaudeModels(null)` directly.
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

describe("isKnownModelId", () => {
  test("accepts a catalog id, and nothing else", async () => {
    const { isKnownModelId } = await modulePromise;

    expect(isKnownModelId("opus")).toBe(true);
    expect(isKnownModelId("not-a-model")).toBe(false);
  });
});

describe("listClaudeModels", () => {
  // The cache path is keyed off the CLI's own `$HOME`, not `PACO_HOME` —
  // see the comment on `gatewayModelCachePath` in model-catalog.ts for why
  // those two are deliberately not the same thing.
  let previousHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "paco-model-catalog-test-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("returns the static tier aliases when no base URL is configured", async () => {
    const { listClaudeModels } = await modulePromise;

    expect(listClaudeModels(null).map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  /**
   * A gateway an operator just configured has not been queried by the CLI
   * yet, so its cache file doesn't exist. This must not empty the picker.
   */
  test("falls back to the tier aliases when a base URL is set but the cache is absent", async () => {
    const { listClaudeModels } = await modulePromise;

    const models = listClaudeModels("https://llm.example.com");

    expect(models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("falls back to the tier aliases when the cache file is unreadable garbage", async () => {
    const { listClaudeModels } = await modulePromise;

    const cacheDir = join(tempHome, ".claude", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "gateway-models.json"), "not json");

    const models = listClaudeModels("https://llm.example.com");

    expect(models.map((model) => model.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("reads the CLI's discovery cache when a base URL is set", async () => {
    const { listClaudeModels } = await modulePromise;

    const cacheDir = join(tempHome, ".claude", "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "gateway-models.json"),
      JSON.stringify({
        data: [
          { id: "claude-gateway-a", display_name: "Gateway Model A" },
          { id: "claude-gateway-b", display_name: "Gateway Model B" },
        ],
      }),
    );

    const models = listClaudeModels("https://llm.example.com");

    expect(models).toEqual([
      {
        id: "claude-gateway-a",
        name: "Gateway Model A",
        modelType: "language",
      },
      {
        id: "claude-gateway-b",
        name: "Gateway Model B",
        modelType: "language",
      },
    ]);
  });
});
