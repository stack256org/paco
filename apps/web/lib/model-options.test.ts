import { describe, expect, test } from "bun:test";
import { buildModelOptions, getDefaultModelOptionId } from "./model-options";
import type { AvailableModel } from "./models";

const MODELS: AvailableModel[] = [
  { id: "opus", name: "Claude Opus", modelType: "language" },
  { id: "sonnet", name: "Claude Sonnet", modelType: "language" },
  { id: "haiku", name: "Claude Haiku", modelType: "language" },
];

describe("buildModelOptions", () => {
  test("returns one option per model, in order", () => {
    expect(buildModelOptions(MODELS).map((option) => option.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("strips the brand prefix for the compact label", () => {
    // The pill beside the composer has little room, and everything here is a
    // Claude, so repeating it wastes the space.
    const [opus] = buildModelOptions(MODELS);

    expect(opus?.label).toBe("Claude Opus");
    expect(opus?.shortLabel).toBe("Opus");
  });

  test("attributes bare tier ids to Anthropic", () => {
    // Paco's ids carry no provider prefix. Returning the alias itself made the
    // picker group models under headings named "Opus" and "Sonnet".
    expect(buildModelOptions(MODELS).map((option) => option.provider)).toEqual([
      "anthropic",
      "anthropic",
      "anthropic",
    ]);
  });

  test("carries context window and cost through when present", () => {
    const options = buildModelOptions([
      {
        id: "sonnet",
        name: "Claude Sonnet",
        context_window: 1_000_000,
        cost: { input: 3, output: 15 },
      },
    ]);

    expect(options[0]?.contextWindow).toBe(1_000_000);
    expect(options[0]?.cost).toEqual({ input: 3, output: 15 });
  });
});

describe("getDefaultModelOptionId", () => {
  test("prefers the app default when it is available", () => {
    expect(getDefaultModelOptionId(buildModelOptions(MODELS))).toBe("opus");
  });

  test("falls back to the first option when the default is missing", () => {
    const withoutDefault = buildModelOptions([
      { id: "haiku", name: "Claude Haiku" },
    ]);

    expect(getDefaultModelOptionId(withoutDefault)).toBe("haiku");
  });

  test("falls back to the app default when there are no options at all", () => {
    expect(getDefaultModelOptionId([])).toBe("opus");
  });
});
