"use client";

import { type FormEvent, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import type { RosterAgentRow, SaveRosterAgentResult } from "./actions";
import { AgentEditorForm } from "./agent-editor-form";
import {
  type AgentFormState,
  agentToFormState,
  buildSaveInput,
  emptyFormState,
  normalizeCustomTool,
} from "./agent-form-state";

interface AgentEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being edited, or `null` to create a new one. */
  agent: RosterAgentRow | null;
  onSave: (input: {
    originalName: string | null;
    name: string;
    definition: unknown;
  }) => Promise<SaveRosterAgentResult>;
  /** Called after a successful save, so the caller can refresh its list. */
  onSaved: () => void;
}

/**
 * Create or edit one roster agent.
 *
 * Name is locked once a builtin agent exists under it — `saveRosterAgent`
 * refuses a builtin rename outright, so the field is disabled here rather
 * than let an admin type a new name and only learn it was rejected on
 * submit. A custom agent's name stays editable: `saveRosterAgent` treats a
 * changed name as a rename, moving the row rather than duplicating it.
 *
 * The dialog chrome and the fields are two components (`AgentEditorForm`
 * carries every field) so the fields can be rendered and tested without the
 * `Dialog`/`Portal` around them — see that file's docstring.
 */
export function AgentEditorDialog({
  open,
  onOpenChange,
  agent,
  onSave,
  onSaved,
}: AgentEditorDialogProps) {
  const [form, setForm] = useState<AgentFormState>(() =>
    agent ? agentToFormState(agent) : emptyFormState(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newTool, setNewTool] = useState("");

  // Resets whenever the dialog opens, or the row being edited changes under
  // it — not on every keystroke, since `form` itself is deliberately absent
  // from the dependency list.
  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(agent ? agentToFormState(agent) : emptyFormState());
    setFieldErrors({});
    setFormError(null);
    setNewTool("");
  }, [open, agent]);

  const isBuiltin = agent?.builtin ?? false;
  const title = agent ? `Edit ${agent.name}` : "New agent";

  function addCustomTool() {
    const tool = normalizeCustomTool(form.tools, newTool);
    if (tool) {
      setForm((prev) => ({ ...prev, tools: [...prev.tools, tool] }));
    }
    setNewTool("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setFormError(null);

    try {
      const input = buildSaveInput(form, agent);
      const result = await onSave(input);
      if (result.success) {
        toast.success(agent ? "Agent updated." : "Agent created.");
        onSaved();
        onOpenChange(false);
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setFormError(result.error);
      }
    } catch {
      setFormError("That agent could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isBuiltin
              ? "Builtin agents can be reconfigured, but not renamed or removed."
              : "Custom agents run only for this organisation."}
          </DialogDescription>
        </DialogHeader>

        <AgentEditorForm
          fieldErrors={fieldErrors}
          form={form}
          formError={formError}
          isBuiltin={isBuiltin}
          newTool={newTool}
          onAddCustomTool={addCustomTool}
          onCancel={() => onOpenChange(false)}
          onFormChange={setForm}
          onNewToolChange={setNewTool}
          onSubmit={(event) => void handleSubmit(event)}
          saving={saving}
        />
      </DialogContent>
    </Dialog>
  );
}
