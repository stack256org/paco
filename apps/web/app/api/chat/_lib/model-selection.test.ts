import { describe, expect, mock, test } from "bun:test";

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
});
