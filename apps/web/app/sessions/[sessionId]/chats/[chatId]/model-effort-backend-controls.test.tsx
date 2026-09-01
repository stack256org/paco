import { describe, expect, test } from "bun:test";
import type { BackendCapabilities } from "@paco/agent-backend";
import { renderToStaticMarkup } from "react-dom/server";
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
    id: "other/model-a",
    label: "Other Model A",
    shortLabel: "Model A",
    provider: "other",
  },
];

const CLAUDE_CAPABILITIES: BackendCapabilities = {
  id: "claude-code",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: true,
  subagents: true,
  images: true,
  compaction: true,
};

/**
 * A hypothetical second backend's shape, and the reason this file is worth
 * having.
 *
 * A past backend reported `effort: false` AND `models: []`, so both controls
 * vanished together and a `backend === "..."` check would have passed every
 * test here. This fixture splits them: a `model` select stays, while the
 * effort control goes. A component that hid on the id rather than on the
 * object would now hide the wrong half.
 *
 * Written out as a plain object rather than read from a real backend, and
 * deliberately so: what is under test here is the SHAPE of the rule — effort
 * off, models present — not any one backend's current answer, and half these
 * tests mutate the object anyway to reach cases no real backend reports
 * today.
 */
const OTHER_CAPABILITIES: BackendCapabilities = {
  id: "other",
  resume: true,
  steering: "restart",
  mcp: true,
  effort: false,
  subagents: true,
  images: false,
  compaction: false,
  models: ["other/model-a"],
};

const noop = () => {
  // no-op: only the rendered markup is asserted below
};

function render(capabilities: BackendCapabilities, modelId = "sonnet") {
  return renderToStaticMarkup(
    <ModelEffortBackendControls
      capabilities={capabilities}
      disabled={false}
      effort={null}
      modelId={modelId}
      modelOptions={MODEL_OPTIONS}
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
    const html = render(OTHER_CAPABILITIES);

    expect(html).not.toContain("Change how hard Paco thinks");
  });

  test("shows the model control for a backend that declares no model list", () => {
    const html = render(CLAUDE_CAPABILITIES);

    expect(html).toContain("Change model");
  });

  /**
   * The half of the row a backend that publishes its own models keeps. The
   * picker is not "the Claude picker": it renders whatever ids the backend
   * accepts.
   */
  test("keeps the model control for a backend that publishes its own models", () => {
    const html = render(OTHER_CAPABILITIES);

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
    const html = render({ ...OTHER_CAPABILITIES, models: [] });

    expect(html).not.toContain("Change model");
  });

  /**
   * The anti-regression test for the whole file: a backend can report
   * `effort: true` even while carrying another backend's id, and the
   * capability object has to win. Any reintroduced `capabilities.id === …`
   * check fails here even though every other test in this file would still
   * pass.
   */
  test("follows the capability object, not the backend id, when they disagree", () => {
    const effortlessClaude = render({
      ...CLAUDE_CAPABILITIES,
      effort: false,
    });
    expect(effortlessClaude).not.toContain("Change how hard Paco thinks");

    const capableOther = render({
      ...OTHER_CAPABILITIES,
      effort: true,
    });
    expect(capableOther).toContain("Change how hard Paco thinks");
  });

  /**
   * The cross-vendor filter, asserted through the one thing a static render
   * makes observable about it.
   *
   * `ModelSelectorCompact` renders the SELECTED option's `shortLabel`, and
   * falls back to the raw id when the option is not in the list it was given.
   * So another vendor's id showing as "other/model-a" rather than "Model A"
   * is proof the filter removed it.
   *
   * This is the client half of the bug the server-side catalog opened:
   * once the catalog spans vendors, handing every option to every
   * backend offers one vendor's model to a chat running a different one,
   * whose CLI rejects it. `capabilitiesForBackend` expands `models:
   * undefined` into an explicit Claude id set before it reaches this
   * component, and this test fails if that expansion stops being honoured
   * here.
   */
  test("does not offer another vendor's model to a backend that lists its own", () => {
    const claudeOnly: BackendCapabilities = {
      ...CLAUDE_CAPABILITIES,
      models: ["sonnet", "haiku"],
    };

    expect(render(claudeOnly, "sonnet")).toContain("Sonnet");

    const html = render(claudeOnly, "other/model-a");
    expect(html).toContain("other/model-a");
    expect(html).not.toContain("Model A");
  });

  /**
   * ...and the raw id it falls back to must not read as a working selection.
   *
   * The screenshot that opened this bug showed a chat whose composer said
   * "opus" while running a backend that could not run it: the id was not in
   * the filtered list, so the trigger rendered it verbatim, with the
   * provider icon dropped and nothing else changed. It looked exactly like a
   * chosen model. The id is still shown — "opus" says what is wrong where an
   * empty button says nothing — but as a warning, and the tooltip names the
   * problem.
   */
  test("marks a model the backend cannot run instead of passing it off as chosen", () => {
    const html = render(OTHER_CAPABILITIES, "opus");

    expect(html).toContain("opus");
    expect(html).toContain("text-warning");
    expect(html).toContain("isn&#x27;t available on this backend");
  });

  test("does not mark a model the backend does run", () => {
    const html = render(OTHER_CAPABILITIES, "other/model-a");

    expect(html).not.toContain("text-warning");
    expect(html).toContain("Change model (⌘⌥/)");
  });

  /** And the mirror: a backend's own id survives its own list. */
  test("offers a backend's own model to a chat running it", () => {
    const html = render(OTHER_CAPABILITIES, "other/model-a");

    expect(html).toContain("Model A");
  });
});
