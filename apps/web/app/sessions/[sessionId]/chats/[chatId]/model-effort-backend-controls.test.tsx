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

  test("always shows the model and backend controls regardless of capabilities", () => {
    const claudeHtml = render(CLAUDE_CAPABILITIES);
    const openfxHtml = render(OPENFX_CAPABILITIES);

    for (const html of [claudeHtml, openfxHtml]) {
      expect(html).toContain("Change model");
      expect(html).toContain("Change agent backend");
    }
  });
});
