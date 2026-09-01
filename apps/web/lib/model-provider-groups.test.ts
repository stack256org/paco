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
   * literal string "Anthropic" above every model in the list, so a chat
   * running a second vendor's models read "Anthropic / Model A / Model B".
   */
  test("heads a second vendor's models with that vendor, not with Anthropic", () => {
    const groups = groupModelsByProvider([
      { id: "acme/model-a" },
      { id: "acme/model-b" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe("acme");
    expect(groups[0]?.label).toBe("Acme");
    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "acme/model-a",
      "acme/model-b",
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
      { id: "acme/model-a" },
      { id: "sonnet" },
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Anthropic", "Acme"]);
    expect(groups[0]?.options.map((option) => option.id)).toEqual([
      "opus",
      "sonnet",
    ]);
    expect(groups[1]?.options.map((option) => option.id)).toEqual([
      "acme/model-a",
    ]);
  });

  /**
   * `ModelOption` computes its provider once, at `buildModelOptions` time.
   * An explicit provider is authoritative — it is how an id whose prefix says
   * nothing useful can still be filed correctly.
   */
  test("prefers an explicit provider over the id's prefix", () => {
    expect(headings([{ id: "some-internal-id", provider: "acme" }])).toEqual([
      "Acme",
    ]);
  });

  test("orders priority providers first, then the rest alphabetically", () => {
    expect(
      headings([{ id: "zeta/one" }, { id: "acme/model-a" }, { id: "opus" }]),
    ).toEqual(["Anthropic", "Acme", "Zeta"]);
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
