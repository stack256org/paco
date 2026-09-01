import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));

const { resolveChatModelSelection } = await import("./model-selection");

describe("resolveChatModelSelection", () => {
  test("passes a tier through unchanged", () => {
    expect(
      resolveChatModelSelection({ selectedModelId: "opus", label: "Model" }),
    ).toEqual({ id: "opus" });
  });

  test("falls back to the default when nothing is selected", () => {
    // Opus: the chat's own model is the orchestrator, and it delegates
    // implementation to Sonnet and lookups to Haiku.
    expect(
      resolveChatModelSelection({ selectedModelId: null, label: "Model" }),
    ).toEqual({ id: "opus" });
  });

  test("carries effort through as its own flag", () => {
    // --model and --effort are separate CLI flags, so they stay separate here
    // rather than being fused into one named pairing that has to exist first.
    expect(
      resolveChatModelSelection({
        selectedModelId: "opus",
        effort: "xhigh",
        label: "Model",
      }),
    ).toEqual({ id: "opus", effort: "xhigh" });
  });

  test("omits effort entirely when the default is chosen", () => {
    // Sending no --effort lets the model use its own default, which is a real
    // choice and not equivalent to any named level.
    expect(
      resolveChatModelSelection({
        selectedModelId: "sonnet",
        effort: null,
        label: "Model",
      }),
    ).toEqual({ id: "sonnet" });
  });

  test("ignores an effort value that is not a known level", () => {
    expect(
      resolveChatModelSelection({
        selectedModelId: "sonnet",
        effort: "turbo" as never,
        label: "Model",
      }),
    ).toEqual({ id: "sonnet" });
  });

  test("rejects a gateway model id when no gateway is configured", () => {
    const originalWarn = console.warn;
    console.warn = () => {
      // Silenced: this case warns on purpose.
    };

    try {
      expect(
        resolveChatModelSelection({
          selectedModelId: "claude-gateway-model",
          label: "Model",
        }),
      ).toEqual({ id: "opus" });
    } finally {
      console.warn = originalWarn;
    }
  });

  /*
   * Half of Critical 2: a gateway model id the operator actually picked in
   * the composer must not be rejected here and silently swapped for the
   * default — `isKnownModelId`'s default (static-alias-only) check would
   * otherwise treat every gateway id as unknown.
   */
  describe("with a gateway configured and discovered", () => {
    let previousHome: string | undefined;
    let tempHome: string;

    beforeEach(() => {
      previousHome = process.env.HOME;
      tempHome = mkdtempSync(join(tmpdir(), "paco-model-selection-test-"));
      process.env.HOME = tempHome;

      const cacheDir = join(tempHome, ".claude", "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, "gateway-models.json"),
        JSON.stringify({
          data: [{ id: "claude-gateway-model", display_name: "Gateway Model" }],
        }),
      );
    });

    afterEach(() => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(tempHome, { recursive: true, force: true });
    });

    test("accepts a model id the configured gateway actually offers", () => {
      expect(
        resolveChatModelSelection({
          selectedModelId: "claude-gateway-model",
          label: "Model",
          claudeBaseUrl: "https://llm.example.com",
        }),
      ).toEqual({ id: "claude-gateway-model" });
    });
  });
});
