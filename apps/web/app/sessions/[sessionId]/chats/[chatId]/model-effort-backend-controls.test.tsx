import { describe, expect, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatBackendSelection } from "@/components/backend-selector-compact";
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
  {
    id: "poolside/laguna-s-2.1",
    label: "Poolside Laguna S",
    shortLabel: "Laguna S",
    provider: "poolside",
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

/**
 * Poolside's shape, and the reason this file is worth having.
 *
 * OpenFX reported `effort: false` AND `models: []`, so both controls vanished
 * together and a `backend === "openfx"` check would have passed every test
 * here. Poolside splits them: `pool`'s `session/new` answers with a `model`
 * select, so the picker stays, while its only reasoning knob is a two-valued
 * `thought_level` that does not map onto Paco's effort levels, so the effort
 * control goes. A component that hid on the id rather than on the object
 * would now hide the wrong half.
 */
const POOLSIDE_CAPABILITIES: BackendCapabilities = {
  id: "poolside",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: false,
  subagents: true,
  models: ["poolside/laguna-s-2.1"],
};

const noop = () => {
  // no-op: only the rendered markup is asserted below
};

function render(
  capabilities: BackendCapabilities,
  backend: ChatBackendSelection = "claude-code",
  modelId = "sonnet",
) {
  return renderToStaticMarkup(
    <ModelEffortBackendControls
      backend={backend}
      capabilities={capabilities}
      disabled={false}
      effort={null}
      modelId={modelId}
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
    const html = render(POOLSIDE_CAPABILITIES, "poolside");

    expect(html).not.toContain("Change how hard Paco thinks");
  });

  test("shows the model control for a backend that declares no model list", () => {
    const html = render(CLAUDE_CAPABILITIES);

    expect(html).toContain("Change model");
  });

  /**
   * The half of the row Poolside keeps. The picker is not "the Claude
   * picker": it renders whatever ids the backend accepts, which for Poolside
   * are its own `poolside/laguna-*` models.
   */
  test("keeps the model control for Poolside, which publishes its own models", () => {
    const html = render(POOLSIDE_CAPABILITIES, "poolside");

    expect(html).toContain("Change model");
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

  test("hides the model control when the backend takes no model from the picker", () => {
    const html = render({ ...POOLSIDE_CAPABILITIES, models: [] }, "poolside");

    expect(html).not.toContain("Change model");
  });

  /**
   * The anti-regression test for the whole file: the `backend` prop says
   * `"claude-code"` while the capability object says otherwise, and the
   * capability object has to win. Any reintroduced `backend === …` check
   * fails here even though every other test in this file would still pass.
   */
  test("follows the capability object, not the backend id, when they disagree", () => {
    const effortlessClaude = render({
      ...CLAUDE_CAPABILITIES,
      effort: false,
    });
    expect(effortlessClaude).not.toContain("Change how hard Paco thinks");

    const capablePoolside = render(
      { ...POOLSIDE_CAPABILITIES, effort: true },
      "poolside",
    );
    expect(capablePoolside).toContain("Change how hard Paco thinks");
  });

  /**
   * The cross-vendor filter, asserted through the one thing a static render
   * makes observable about it.
   *
   * `ModelSelectorCompact` renders the SELECTED option's `shortLabel`, and
   * falls back to the raw id when the option is not in the list it was given
   * (`displayText = selectedOption?.shortLabel ?? value`). So a Poolside id
   * showing as "poolside/laguna-s-2.1" rather than "Laguna S" is proof the
   * filter removed it.
   *
   * This is the client half of the bug `listAllModels()` opened on the
   * server: once the catalog spans vendors, handing every option to every
   * backend offers `poolside/laguna-*` to a Claude Code chat, whose CLI
   * rejects it. `capabilitiesForBackend` expands `models: undefined` into an
   * explicit Claude id set before it reaches this component, and this test
   * fails if that expansion stops being honoured here.
   */
  test("does not offer another vendor's model to a backend that lists its own", () => {
    const claudeOnly: BackendCapabilities = {
      ...CLAUDE_CAPABILITIES,
      models: ["sonnet", "haiku"],
    };

    expect(render(claudeOnly, "claude-code", "sonnet")).toContain("Sonnet");

    const html = render(claudeOnly, "claude-code", "poolside/laguna-s-2.1");
    expect(html).toContain("poolside/laguna-s-2.1");
    expect(html).not.toContain("Laguna S");
  });

  /** And the mirror: Poolside's own id survives its own list. */
  test("offers a Poolside model to a Poolside chat", () => {
    const html = render(
      POOLSIDE_CAPABILITIES,
      "poolside",
      "poolside/laguna-s-2.1",
    );

    expect(html).toContain("Laguna S");
  });

  test("always shows the backend control regardless of capabilities", () => {
    const claudeHtml = render(CLAUDE_CAPABILITIES);
    const poolsideHtml = render(POOLSIDE_CAPABILITIES, "poolside");

    for (const html of [claudeHtml, poolsideHtml]) {
      expect(html).toContain("Change agent backend");
    }
  });

  /**
   * The selector offers exactly the `chats.backend` enum. Asserted from the
   * composer because that is the only place it is rendered, and asserted on
   * the trigger's own label so a chat that is already on Poolside shows
   * Poolside rather than silently falling back to Claude Code.
   */
  test("names the chat's backend on the trigger", () => {
    expect(render(POOLSIDE_CAPABILITIES, "poolside")).toContain(
      "Backend: Poolside",
    );
    expect(render(CLAUDE_CAPABILITIES)).toContain("Backend: Claude Code");
  });
});
