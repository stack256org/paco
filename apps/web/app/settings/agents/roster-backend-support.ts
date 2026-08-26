import type { BackendCapabilities } from "@paco/agent-backend";

/**
 * Display names for the backend ids `BackendCapabilities.id` reports.
 *
 * A name is not a claim, which is the same reason
 * `describeBackendLimitations` skips `id` when deriving copy from a
 * capability object: nothing here decides whether a backend takes the
 * roster — `customAgents` does — so a map of labels cannot go stale into a
 * lie the way a hardcoded "Poolside chats lose this" sentence can. An id
 * with no entry renders as itself rather than being dropped, so a backend
 * added without touching this file still appears in the notice.
 */
const BACKEND_LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  poolside: "Poolside",
};

export function backendLabel(id: string): string {
  return BACKEND_LABELS[id] ?? id;
}

/** A backend that runs its own agents instead of the roster on this page. */
export interface IgnoringBackend {
  id: string;
  label: string;
  /**
   * The roster's per-agent model ids this backend does not accept, read off
   * `capabilities.models`.
   *
   * Empty when the backend publishes no narrowed list (`models: undefined`,
   * "the app's own catalog applies"), and — deliberately — the whole roster
   * when it publishes an EMPTY list, which `BackendCapabilities` defines as
   * "I resolve my own model and take none from the picker".
   */
  unknownModelIds: readonly string[];
}

export interface RosterBackendSupport {
  /** Labels of the backends whose turns are actually handed this roster. */
  honouring: readonly string[];
  /** The backends that are not, with what their model list makes of the tiers. */
  ignoring: readonly IgnoringBackend[];
}

/**
 * Which backends this organisation's roster reaches, derived from what each
 * one reports rather than from its name.
 *
 * `customAgents` is the whole test: the interface defines `undefined` as
 * "yes" (the assumption every backend written before the field existed was
 * built on) and only an explicit `false` as "a caller's roster is not
 * installable here". Reading that instead of comparing against `"poolside"`
 * is what stops this page from repeating the OpenFX warnings that stayed on
 * screen after the backend under them changed — and what makes a third
 * backend appear in the notice without an edit here.
 *
 * `rosterModelIds` are the ids the roster's rows actually carry
 * (`opus`/`sonnet`/`haiku` for a seeded org), passed in rather than
 * hardcoded so the sentence about model tiers describes THIS roster. They
 * are matched against the backend's own `models` list, so "these are not ids
 * it accepts" is a comparison rather than an assertion.
 *
 * Pure, and exported separately from the component, so both halves are
 * testable without a DOM.
 */
export function describeRosterBackendSupport(
  backends: readonly BackendCapabilities[],
  rosterModelIds: readonly string[],
): RosterBackendSupport {
  const honouring: string[] = [];
  const ignoring: IgnoringBackend[] = [];

  for (const capabilities of backends) {
    if (capabilities.customAgents !== false) {
      honouring.push(backendLabel(capabilities.id));
      continue;
    }

    const accepted = capabilities.models;
    const unknownModelIds =
      accepted === undefined
        ? []
        : [...new Set(rosterModelIds)]
            .filter((id) => !accepted.includes(id))
            .sort();

    ignoring.push({
      id: capabilities.id,
      label: backendLabel(capabilities.id),
      unknownModelIds,
    });
  }

  return { honouring, ignoring };
}

/**
 * "a, b and c" — the one place the notice's lists are joined, so a roster of
 * one model id does not read as "haiku and " with a dangling conjunction.
 */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
