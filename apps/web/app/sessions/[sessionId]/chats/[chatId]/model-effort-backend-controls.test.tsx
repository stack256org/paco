import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BackendCapabilities } from "@paco/agent-backend";
import type { ModelOption } from "@/lib/model-options";
import { ModelEffortBackendControls } from "./model-effort-backend-controls";

const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "sonnet",
    label: "Claude Sonnet",
    shortLabel: "Sonnet",
    provider: "anthropic",
  },
  {
    id: "haiku",
    label: "Claude Haiku",
    shortLabel: "Haiku",
    provider: "anthropic",
  },
];

const CLAUDE_CAPABILITIES: BackendCapabilities = {
  id: "claude-code",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: true,
  subagents: true,
};

const OPENFX_CAPABILITIES: BackendCapabilities = {
  id: "openfx",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: false,
  subagents: true,
  customAgents: false,
  structuredOutput: false,
  // The binary resolves its own model; the picker's Claude tier aliases
  // mean nothing to it.
  models: [],
};

const noop = () => {
  // no-op: only the rendered markup is asserted below
};

function render(capabilities: BackendCapabilities) {
  return renderToStaticMarkup(
    <ModelEffortBackendControls
      backend={capabilities.id === "openfx" ? "openfx" : "claude-code"}
      capabilities={capabilities}
      disabled={false}
      effort={null}
      modelId="sonnet"
      modelOptions={MODEL_OPTIONS}
      onBackendChange={noop}
      onEffortChange={noop}
      onModelChange={noop}
    />,
  );
}

describe("ModelEffortBackendControls", () => {
  test("shows the effort control when the backend reports effort: true", () => {
    const html = render(CLAUDE_CAPABILITIES);

    expect(html).toContain("Change how hard Paco thinks");
  });

  test("hides the effort control when the backend reports effort: false", () => {
    const html = render(OPENFX_CAPABILITIES);

    expect(html).not.toContain("Change how hard Paco thinks");
  });

  test("shows the model control for a backend that declares no model list", () => {
    const html = render(CLAUDE_CAPABILITIES);

    expect(html).toContain("Change model");
  });

  /**
   * The picker was Claude-only: it offered opus/sonnet/haiku whatever the
   * chat ran on, and the chosen alias went to OpenFX as `--model`. Hidden
   * the same way the effort control already is, so a backend switch does not
   * leave a control on screen that decides nothing.
   */
  test("hides the model control when the backend takes no model from the picker", () => {
    const html = render(OPENFX_CAPABILITIES);

    expect(html).not.toContain("Change model");
  });

  /**
   * The trigger renders the selected value, not the option list (that lives
   * in a popover this static render never opens), so what is observable
   * here is whether the control survives the filter at all. The id-level
   * rule itself is covered by `lib/model-catalog.test.ts`.
   */
  test("keeps the model control when the backend accepts some of the picker's models", () => {
    const html = render({ ...CLAUDE_CAPABILITIES, models: ["haiku"] });

    expect(html).toContain("Change model");
  });

  test("always shows the backend control regardless of capabilities", () => {
    const claudeHtml = render(CLAUDE_CAPABILITIES);
    const openfxHtml = render(OPENFX_CAPABILITIES);

    for (const html of [claudeHtml, openfxHtml]) {
      expect(html).toContain("Change agent backend");
    }
  });
});
