import type { AgentDefinition } from "@/lib/agent/agent-definition-schema";
import type { RosterAgentRow } from "./actions";

/** The known reasoning-effort levels, in the order the select offers them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The known model tiers, in the order the select offers them. */
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;

/**
 * The editor dialog's form fields, kept as strings even where the definition
 * field is typed otherwise (`maxTurns`) — an `<input>` reports a string
 * regardless, and coercing at every keystroke just to coerce back on submit
 * bought nothing.
 */
export interface AgentFormState {
  name: string;
  description: string;
  prompt: string;
  /** `""` means "inherit the main model". */
  model: string;
  /** `""` means "inherit the parent's effort". */
  effort: string;
  /** `""` means "no limit". */
  maxTurns: string;
  /** Whether `tools` is restricted at all, vs. omitted (inherit everything). */
  toolsRestricted: boolean;
  tools: string[];
}

/** A blank form, for creating a brand-new agent. */
export function emptyFormState(): AgentFormState {
  return {
    name: "",
    description: "",
    prompt: "",
    model: "",
    effort: "",
    maxTurns: "",
    toolsRestricted: false,
    tools: [],
  };
}

/** The form state that reproduces an existing roster row, for editing it. */
export function agentToFormState(agent: RosterAgentRow): AgentFormState {
  const { definition } = agent;
  return {
    name: agent.name,
    description: definition.description,
    prompt: definition.prompt,
    model: definition.model ?? "",
    effort: definition.effort ?? "",
    maxTurns:
      definition.maxTurns === undefined ? "" : String(definition.maxTurns),
    toolsRestricted: definition.tools !== undefined,
    tools: definition.tools ?? [],
  };
}

/**
 * The `AgentDefinition` a submitted form describes.
 *
 * `disallowedTools` has no field in the dialog (the brief's field list omits
 * it), so it is carried over from whatever the row already had rather than
 * silently dropped on the next save — `original` is the row being edited, or
 * `null` when creating a new agent, which never has one to preserve.
 */
export function formStateToDefinition(
  state: AgentFormState,
  original: AgentDefinition | null,
): AgentDefinition {
  const maxTurns = state.maxTurns.trim();
  const parsedMaxTurns = maxTurns === "" ? undefined : Number(maxTurns);

  return {
    description: state.description.trim(),
    prompt: state.prompt,
    ...(state.model ? { model: state.model } : {}),
    ...(state.toolsRestricted ? { tools: state.tools } : {}),
    ...(original?.disallowedTools
      ? { disallowedTools: original.disallowedTools }
      : {}),
    ...(state.effort
      ? { effort: state.effort as NonNullable<AgentDefinition["effort"]> }
      : {}),
    ...(parsedMaxTurns === undefined || Number.isNaN(parsedMaxTurns)
      ? {}
      : { maxTurns: parsedMaxTurns }),
  };
}

/** The payload `saveRosterAgent` expects, built from one submission. */
export interface SaveRosterAgentInput {
  originalName: string | null;
  name: string;
  definition: unknown;
}

/**
 * Turns a submitted form into the exact call `saveRosterAgent` receives.
 *
 * Extracted from the dialog component so it can be exercised without a DOM:
 * this codebase's test runner has no browser environment to click a button
 * in, so "save calls the action with edited values" is verified at this
 * boundary — the value the dialog would hand the action — instead.
 */
export function buildSaveInput(
  state: AgentFormState,
  agent: RosterAgentRow | null,
): SaveRosterAgentInput {
  return {
    originalName: agent?.name ?? null,
    name: state.name.trim(),
    definition: formStateToDefinition(state, agent?.definition ?? null),
  };
}
