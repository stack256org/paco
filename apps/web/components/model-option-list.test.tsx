import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Command, CommandList } from "@/components/ui/command";
import { buildModelOptions } from "@/lib/model-options";
import type { AvailableModel } from "@/lib/models";
import { ModelOptionList } from "./model-option-list";

const CLAUDE_MODELS: AvailableModel[] = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

/** A hypothetical second vendor's models, for exercising the grouping rule. */
const OTHER_VENDOR_MODELS: AvailableModel[] = [
  { id: "acme/model-a", name: "Model A" },
  { id: "acme/model-b", name: "Model B" },
];

const noop = () => {
  // no-op: only the rendered markup is asserted below
};

/**
 * The list as the popover renders it, minus the popover.
 *
 * `ModelSelectorCompact`'s popup only mounts on open, so nothing about the
 * option list was observable from a static render while it lived inline —
 * which is how a hardcoded `heading="Anthropic"` survived a second vendor
 * arriving. `Command` is a plain div with a context, so the list renders
 * under it exactly as it does in the picker.
 */
function render(models: AvailableModel[], value = "") {
  return renderToStaticMarkup(
    <Command>
      <CommandList>
        <ModelOptionList
          onSelect={noop}
          options={buildModelOptions(models)}
          value={value}
        />
      </CommandList>
    </Command>,
  );
}

/** The group headings, in render order. */
function headings(html: string): string[] {
  return [
    ...html.matchAll(
      /<div class="px-2 py-1\.5 text-xs font-medium text-base-content\/60">([^<]*)<\/div>/g,
    ),
  ].map((match) => match[1] ?? "");
}

describe("ModelOptionList", () => {
  /**
   * Bug 2 as the operator saw it: a chat running a second vendor's models
   * had its dropdown list them under a heading that read "Anthropic",
   * because the group heading was the literal string.
   */
  test("heads a second vendor's models with that vendor", () => {
    const html = render(OTHER_VENDOR_MODELS);

    expect(headings(html)).toEqual(["Acme"]);
    expect(html).not.toContain("Anthropic");
    expect(html).toContain("Model A");
    expect(html).toContain("Model B");
  });

  /**
   * And the rule that must survive the fix: Paco's own ids are bare tier
   * aliases with no provider prefix, and they still belong to Anthropic. A
   * grouping that read the id as the provider would head them "Opus" and
   * "Sonnet", as though those were vendors.
   */
  test("heads unprefixed Claude aliases with Anthropic, as one group", () => {
    const html = render(CLAUDE_MODELS);

    expect(headings(html)).toEqual(["Anthropic"]);
  });

  test("splits a mixed list into one heading per vendor", () => {
    const html = render([...CLAUDE_MODELS, ...OTHER_VENDOR_MODELS]);

    expect(headings(html)).toEqual(["Anthropic", "Acme"]);
  });

  test("ticks the selected model and nothing else", () => {
    const html = render(OTHER_VENDOR_MODELS, "acme/model-b");

    // One visible tick, and it is inside the selected model's own row.
    expect([...html.matchAll(/opacity-100/g)]).toHaveLength(1);
    const rows = html.split("<button");
    const selectedRow = rows.find((row) => row.includes("Model B"));
    const otherRow = rows.find((row) => row.includes(">Model A<"));
    expect(selectedRow).toContain("opacity-100");
    expect(otherRow).toContain("opacity-0");
  });

  /**
   * The "default" marker names the model a NEW chat starts on, which is a
   * Claude tier alias. A different vendor's list therefore carries no
   * marker at all — the honest answer, since Paco has no opinion about
   * which of that vendor's models to start on, rather than a marker moved
   * onto whichever model happens to be first.
   */
  test("marks the app default only where the backend offers it", () => {
    expect(render(CLAUDE_MODELS)).toContain("default");
    expect(render(OTHER_VENDOR_MODELS)).not.toContain(">default<");
  });

  test("renders nothing for an empty option list", () => {
    const html = render([]);

    expect(headings(html)).toEqual([]);
  });
});
