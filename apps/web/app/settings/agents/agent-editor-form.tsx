import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import {
  type AgentFormState,
  EFFORT_LEVELS,
  MODEL_TIERS,
} from "./agent-form-state";
import { KNOWN_TOOL_NAMES } from "./known-tools";

const KNOWN_MODEL_TIERS: readonly string[] = MODEL_TIERS;

interface AgentEditorFormProps {
  form: AgentFormState;
  onFormChange: Dispatch<SetStateAction<AgentFormState>>;
  fieldErrors: Record<string, string>;
  formError: string | null;
  saving: boolean;
  isBuiltin: boolean;
  newTool: string;
  onNewToolChange: (value: string) => void;
  onAddCustomTool: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}

/**
 * Every field in the agent editor, with no `Dialog`/`Portal` around it.
 *
 * Split out of `AgentEditorDialog` so it can be rendered in a test: this
 * codebase's test runner has no DOM, and Base UI's `Dialog.Portal` renders
 * nothing without one — a component that only ever appears inside that
 * portal is unrenderable in a headless test no matter what it contains.
 */
export function AgentEditorForm({
  form,
  onFormChange,
  fieldErrors,
  formError,
  saving,
  isBuiltin,
  newTool,
  onNewToolChange,
  onAddCustomTool,
  onSubmit,
  onCancel,
}: AgentEditorFormProps) {
  function toggleTool(tool: string, checked: boolean) {
    onFormChange((prev) => ({
      ...prev,
      tools: checked
        ? [...prev.tools, tool]
        : prev.tools.filter((existing) => existing !== tool),
    }));
  }

  const extraTools = form.tools.filter(
    (tool) => !KNOWN_TOOL_NAMES.includes(tool),
  );

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {formError ? (
        <div className="alert alert-error alert-soft" role="alert">
          <span>{formError}</span>
        </div>
      ) : null}

      <div className="grid gap-2">
        <label className="label" htmlFor="agent-name">
          Name
        </label>
        <input
          className="input input-sm w-full"
          disabled={isBuiltin || saving}
          id="agent-name"
          onChange={(event) =>
            onFormChange((prev) => ({ ...prev, name: event.target.value }))
          }
          value={form.name}
        />
        {fieldErrors.name ? (
          <p className="text-error text-xs">{fieldErrors.name}</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <label className="label" htmlFor="agent-description">
          Description
        </label>
        <input
          className="input input-sm w-full"
          disabled={saving}
          id="agent-description"
          onChange={(event) =>
            onFormChange((prev) => ({
              ...prev,
              description: event.target.value,
            }))
          }
          value={form.description}
        />
        {fieldErrors.description ? (
          <p className="text-error text-xs">{fieldErrors.description}</p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <label className="label" htmlFor="agent-prompt">
          Prompt
        </label>
        <textarea
          className="textarea w-full"
          disabled={saving}
          id="agent-prompt"
          onChange={(event) =>
            onFormChange((prev) => ({ ...prev, prompt: event.target.value }))
          }
          rows={6}
          value={form.prompt}
        />
        {fieldErrors.prompt ? (
          <p className="text-error text-xs">{fieldErrors.prompt}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <label className="label" htmlFor="agent-model">
            Model
          </label>
          <select
            className="select select-sm w-full"
            disabled={saving}
            id="agent-model"
            onChange={(event) =>
              onFormChange((prev) => ({ ...prev, model: event.target.value }))
            }
            value={form.model}
          >
            <option value="">Inherit</option>
            {MODEL_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
            {/* A definition can carry a full model id instead of a tier
                alias — keep it selectable rather than silently discard it
                the first time this dialog opens. */}
            {form.model && !KNOWN_MODEL_TIERS.includes(form.model) ? (
              <option value={form.model}>{form.model}</option>
            ) : null}
          </select>
        </div>

        <div className="grid gap-2">
          <label className="label" htmlFor="agent-effort">
            Effort
          </label>
          <select
            className="select select-sm w-full"
            disabled={saving}
            id="agent-effort"
            onChange={(event) =>
              onFormChange((prev) => ({ ...prev, effort: event.target.value }))
            }
            value={form.effort}
          >
            <option value="">Inherit</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <label className="label" htmlFor="agent-max-turns">
            Max turns
          </label>
          <input
            className="input input-sm w-full"
            disabled={saving}
            id="agent-max-turns"
            min={1}
            onChange={(event) =>
              onFormChange((prev) => ({
                ...prev,
                maxTurns: event.target.value,
              }))
            }
            type="number"
            value={form.maxTurns}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <label
          className="flex items-center gap-2 text-sm"
          htmlFor="agent-tools-restricted"
        >
          <input
            checked={form.toolsRestricted}
            className="checkbox checkbox-sm"
            disabled={saving}
            id="agent-tools-restricted"
            onChange={(event) =>
              onFormChange((prev) => ({
                ...prev,
                toolsRestricted: event.target.checked,
              }))
            }
            type="checkbox"
          />
          Restrict to specific tools
        </label>

        {form.toolsRestricted ? (
          <div className="space-y-3 rounded-md border border-base-300 p-3">
            <div className="flex flex-wrap gap-3">
              {KNOWN_TOOL_NAMES.map((tool) => (
                <label className="flex items-center gap-1.5 text-sm" key={tool}>
                  <input
                    checked={form.tools.includes(tool)}
                    className="checkbox checkbox-xs"
                    disabled={saving}
                    onChange={(event) => toggleTool(tool, event.target.checked)}
                    type="checkbox"
                    value={tool}
                  />
                  {tool}
                </label>
              ))}
            </div>

            {extraTools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {extraTools.map((tool) => (
                  <span className="badge badge-sm badge-soft gap-1" key={tool}>
                    {tool}
                    <button
                      aria-label={`Remove ${tool}`}
                      className="text-base-content/60"
                      disabled={saving}
                      onClick={() => toggleTool(tool, false)}
                      type="button"
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex gap-2">
              <input
                className="input input-sm flex-1"
                disabled={saving}
                onChange={(event) => onNewToolChange(event.target.value)}
                placeholder="Add another tool by name"
                value={newTool}
              />
              <Button
                disabled={saving || !newTool.trim()}
                onClick={onAddCustomTool}
                size="sm"
                type="button"
                variant="outline"
              >
                Add
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          disabled={saving}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button disabled={saving} type="submit">
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
