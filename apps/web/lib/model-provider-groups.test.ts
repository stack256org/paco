import { describe, expect, test } from "bun:test";
import { groupModelsByProvider } from "./model-provider-groups";

interface TestItem {
  id: string;
  provider?: string;
}

function headings(items: TestItem[]): string[] {
  return groupModelsByProvider(items).map((group) => group.label);
}

describe("groupModelsByProvider", () => {
  /**
   * Bug 2, at the level the compact picker got it wrong: its heading was the
   * literal string "Anthropic" above every model in the list, so a Poolside
   * chat read "Anthropic / Laguna S / Laguna XS".
   */
  test("heads Poolside's models with Poolside, not with Anthropic", () => {
    const groups = groupModelsByProvider([
      { id: "poolside/laguna-s-2.1" },
      { id: "poolside/laguna-xs-2.1" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe("poolside");
    expect(groups[0]?.label).toBe("Poolside");
    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "poolside/laguna-s-2.1",
      "poolside/laguna-xs-2.1",
    ]);
  });

  /**
   * The rule `getProviderFromModelId`'s docstring exists to protect: Paco's
   * own ids are bare tier aliases with no provider prefix, and reading the
   * alias as the provider gave the picker headings named "Opus" and "Sonnet"
   * as though those were vendors.
   */
  test("keeps unprefixed Claude aliases under one Anthropic heading", () => {
    const groups = groupModelsByProvider([
      { id: "opus" },
      { id: "sonnet" },
      { id: "haiku" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Anthropic");
    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "opus",
      "sonnet",
      "haiku",
    ]);
  });

  test("splits a mixed list into one group per vendor", () => {
    const groups = groupModelsByProvider([
      { id: "opus" },
      { id: "poolside/laguna-s-2.1" },
      { id: "sonnet" },
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "Anthropic",
      "Poolside",
    ]);
    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "opus",
      "sonnet",
    ]);
    expect(groups[1]?.options.map((option) => option.id)).toEqual([
      "poolside/laguna-s-2.1",
    ]);
  });

  /**
   * `ModelOption` computes its provider once, at `buildModelOptions` time.
   * An explicit provider is authoritative — it is how an id whose prefix says
   * nothing useful can still be filed correctly.
   */
  test("prefers an explicit provider over the id's prefix", () => {
    expect(
      headings([{ id: "some-internal-id", provider: "poolside" }]),
    ).toEqual(["Poolside"]);
  });

  test("orders priority providers first, then the rest alphabetically", () => {
    expect(
      headings([
        { id: "zeta/one" },
        { id: "poolside/laguna-s-2.1" },
        { id: "opus" },
      ]),
    ).toEqual(["Anthropic", "Poolside", "Zeta"]);
  });

  test("preserves input order inside a group", () => {
    const groups = groupModelsByProvider([
      { id: "haiku" },
      { id: "opus" },
      { id: "sonnet" },
    ]);

    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "haiku",
      "opus",
      "sonnet",
    ]);
  });

  test("groups nothing when given nothing", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});
