/**
 * Reasoning effort, the second axis of model selection.
 *
 * The Claude Code CLI takes a model tier (`--model opus`) and an effort
 * (`--effort high`) as independent flags. Paco used to fuse them into a single
 * "variant" — a named row pairing one model with one effort — so the picker
 * listed "Opus", "Sonnet", "Haiku", "Opus (XHigh effort)", "Sonnet (High
 * effort)" in one flat list, and any pairing nobody had defined simply could
 * not be chosen. Two dropdowns express the same thing with none of that.
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * `null` means "send no `--effort` flag" and let the CLI use the model's own
 * default. It is a real choice, not a missing value, so it is offered.
 */
export type EffortSelection = Effort | null;

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORT_DESCRIPTIONS: Record<Effort, string> = {
  low: "Answers fast, thinks little. Good for edits you have already scoped.",
  medium: "A balance between speed and deliberation.",
  high: "Thinks longer before acting. Good for debugging and design.",
  xhigh: "Considerably more deliberation, at a matching cost in time.",
  max: "As much reasoning as the model will do. Slow and expensive.",
};

export const DEFAULT_EFFORT_LABEL = "Default";

export function isEffort(value: unknown): value is Effort {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Narrow a stored or submitted value, treating anything unrecognised as the default. */
export function parseEffort(value: unknown): EffortSelection {
  return isEffort(value) ? value : null;
}

export function effortLabel(effort: EffortSelection): string {
  return effort ? EFFORT_LABELS[effort] : DEFAULT_EFFORT_LABEL;
}
