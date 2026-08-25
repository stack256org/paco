import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RosterAgentRow } from "./actions";
import { AgentEditorForm } from "./agent-editor-form";
import {
  agentToFormState,
  buildSaveInput,
  emptyFormState,
  formStateToDefinition,
  normalizeCustomTool,
} from "./agent-form-state";

function agent(overrides: Partial<RosterAgentRow> = {}): RosterAgentRow {
  return {
    id: "row-1",
    name: "reviewer",
    builtin: true,
    enabled: true,
    valid: true,
    definition: {
      description: "Reviews finished work.",
      prompt: "You are a reviewer agent.",
      model: "sonnet",
      effort: "high",
      tools: ["Read", "Grep"],
    },
    ...overrides,
  };
}

const noop = () => {};

/**
 * The one `<input .../>` (or `<select ...>...</select>`) whose tag carries
 * the given attribute — order-independent, since React's SSR output does
 * not put attributes in JSX source order for every element consistently.
 */
function tagWith(html: string, attribute: string): string {
  const match = html.match(
    new RegExp(`<(?:input|select)[^>]*${attribute}[^>]*/?>`),
  );
  return match?.[0] ?? "";
}

/**
 * `AgentEditorDialog` wraps this in a `Dialog`/`Portal`, which Base UI does
 * not render outside a browser — this codebase's test runner has no DOM. The
 * fields themselves live in `AgentEditorForm` precisely so they can be
 * rendered here without that wrapper (see that file's docstring).
 */
function renderForm(
  overrides: Partial<Parameters<typeof AgentEditorForm>[0]> = {},
) {
  return renderToStaticMarkup(
    <AgentEditorForm
      fieldErrors={{}}
      form={agentToFormState(agent())}
      formError={null}
      isBuiltin={true}
      newTool=""
      onAddCustomTool={noop}
      onCancel={noop}
      onFormChange={noop}
      onNewToolChange={noop}
      onSubmit={noop}
      saving={false}
      {...overrides}
    />,
  );
}

describe("AgentEditorForm rendering: fields render from a definition", () => {
  test("shows the existing agent's name, description, and prompt", () => {
    const html = renderForm();

    expect(html).toContain('value="reviewer"');
    expect(html).toContain('value="Reviews finished work."');
    expect(html).toContain("You are a reviewer agent.");
  });

  test("selects the definition's model and effort", () => {
    const html = renderForm();

    // React's SSR output marks the matching <option> selected="".
    expect(html).toMatch(/<option[^>]*value="sonnet"[^>]*selected/);
    expect(html).toMatch(/<option[^>]*value="high"[^>]*selected/);
  });

  test("checks the definition's allowed tools", () => {
    const html = renderForm();

    expect(tagWith(html, 'id="agent-tools-restricted"')).toContain("checked");
    expect(tagWith(html, 'value="Read"')).toContain("checked");
    expect(tagWith(html, 'value="Grep"')).toContain("checked");
  });

  test("locks the name field for a builtin agent", () => {
    const html = renderForm({ isBuiltin: true });

    expect(tagWith(html, 'id="agent-name"')).toContain("disabled");
  });

  test("leaves the name field editable for a custom agent", () => {
    const html = renderForm({
      form: agentToFormState(agent({ builtin: false, name: "custom-agent" })),
      isBuiltin: false,
    });

    expect(tagWith(html, 'id="agent-name"')).not.toContain("disabled");
  });

  test("starts blank when creating a new agent", () => {
    const html = renderForm({ form: emptyFormState(), isBuiltin: false });

    expect(html).toContain('id="agent-name" value=""');
  });

  test("shows a field error next to the field it came from", () => {
    const html = renderForm({
      fieldErrors: { name: "That name is already in use." },
    });

    expect(html).toContain("That name is already in use.");
  });

  test("shows the general form error banner", () => {
    const html = renderForm({ formError: "Something else went wrong." });

    expect(html).toContain("Something else went wrong.");
  });
});

/**
 * The dialog's own submit handler is not exercised here — this test runner
 * has no DOM, so there is nothing to click. Instead these test the exact
 * boundary the submit handler crosses: turning form state into the payload
 * `saveRosterAgent` receives, which is what "save calls the action with
 * edited values" actually means in a headless test environment.
 */
describe("form state -> save payload: save calls the action with edited values", () => {
  test("a fresh form building a new agent", () => {
    const state = emptyFormState();
    state.name = "new-agent";
    state.description = "Does new things.";
    state.prompt = "You are new.";
    state.model = "opus";
    state.effort = "low";
    state.maxTurns = "5";

    const input = buildSaveInput(state, null);

    expect(input.originalName).toBeNull();
    expect(input.name).toBe("new-agent");
    expect(input.definition).toEqual({
      description: "Does new things.",
      prompt: "You are new.",
      model: "opus",
      effort: "low",
      maxTurns: 5,
    });
  });

  test("editing an existing agent carries its original name for the rename check", () => {
    const existing = agent({ name: "reviewer" });
    const state = agentToFormState(existing);
    state.description = "An edited description.";

    const input = buildSaveInput(state, existing);

    expect(input.originalName).toBe("reviewer");
    expect(input.name).toBe("reviewer");
    expect((input.definition as { description: string }).description).toBe(
      "An edited description.",
    );
  });

  test("a renamed agent reports both the old and new name", () => {
    const existing = agent({ name: "old-name", builtin: false });
    const state = agentToFormState(existing);
    state.name = "new-name";

    const input = buildSaveInput(state, existing);

    expect(input.originalName).toBe("old-name");
    expect(input.name).toBe("new-name");
  });

  test("an unrestricted tools toggle omits `tools` entirely, meaning inherit-all", () => {
    const state = emptyFormState();
    state.name = "agent";
    state.description = "d";
    state.prompt = "p";
    state.toolsRestricted = false;
    state.tools = ["Read"]; // left over from an earlier toggle, must be ignored

    const definition = formStateToDefinition(state, null);

    expect(definition.tools).toBeUndefined();
  });

  test("a restricted tools toggle includes the chosen tools, known and custom alike", () => {
    const state = emptyFormState();
    state.name = "agent";
    state.description = "d";
    state.prompt = "p";
    state.toolsRestricted = true;
    state.tools = ["Read", "MyCustomTool"];

    const definition = formStateToDefinition(state, null);

    expect(definition.tools).toEqual(["Read", "MyCustomTool"]);
  });

  test("preserves an original definition's disallowedTools, which the dialog has no field for", () => {
    const existing = agent({
      definition: {
        description: "d",
        prompt: "p",
        disallowedTools: ["Bash"],
      },
    });
    const state = agentToFormState(existing);

    const definition = formStateToDefinition(state, existing.definition);

    expect(definition.disallowedTools).toEqual(["Bash"]);
  });

  test("a blank max-turns field omits maxTurns rather than saving 0 or NaN", () => {
    const state = emptyFormState();
    state.name = "agent";
    state.description = "d";
    state.prompt = "p";
    state.maxTurns = "";

    const definition = formStateToDefinition(state, null);

    expect(definition.maxTurns).toBeUndefined();
  });
});

describe("normalizeCustomTool", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeCustomTool([], "  MyTool  ")).toBe("MyTool");
  });

  test("rejects an entry with whitespace inside it", () => {
    expect(normalizeCustomTool([], "My Tool")).toBeNull();
  });

  test("rejects a blank entry", () => {
    expect(normalizeCustomTool([], "   ")).toBeNull();
  });

  test("rejects a case-insensitive duplicate, keeping the existing casing", () => {
    expect(normalizeCustomTool(["Read"], "read")).toBeNull();
    expect(normalizeCustomTool(["Read"], "READ")).toBeNull();
  });

  test("accepts a genuinely new tool name", () => {
    expect(normalizeCustomTool(["Read"], "MyCustomTool")).toBe("MyCustomTool");
  });
});
