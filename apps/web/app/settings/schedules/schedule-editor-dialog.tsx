"use client";

import { type FormEvent, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import type {
  MySessionOption,
  ScheduleActionResult,
  ScheduleFormInput,
  ScheduleRow,
} from "./actions";
import {
  listEnabledAgentNamesForScheduleAction,
  listMySessionsForScheduleAction,
} from "./actions";

const NONE_AGENT_VALUE = "__none__";

export interface ScheduleEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being edited, or `null` to create a new one. */
  schedule: ScheduleRow | null;
  onSave: (input: ScheduleFormInput) => Promise<ScheduleActionResult>;
  /** Called after a successful save, so the caller can refresh its list. */
  onSaved: () => void;
}

function emptyState(): {
  name: string;
  sessionId: string;
  cron: string;
  goal: string;
  assignedAgent: string;
} {
  return {
    name: "",
    sessionId: "",
    cron: "",
    goal: "",
    assignedAgent: NONE_AGENT_VALUE,
  };
}

/**
 * Create or edit one cron schedule.
 *
 * The session picker is scoped to the caller's own sessions
 * (`listMySessionsForScheduleAction`), the same restriction
 * `NewTaskDialog` places on task creation — a schedule always fires a task
 * into some session's repo, and `createScheduleAction`/`updateScheduleAction`
 * re-check that server-side regardless of what this form offers.
 *
 * The cron field is plain text rather than a picker: `createScheduleAction`
 * validates it server-side (`validateCron` in `lib/db/schedules.ts`, the
 * same parser pg-boss's own `schedule()` call uses) and a bad expression
 * comes back as a field error here, so there is no need to constrain input
 * client-side to a subset of what a cron expression can say.
 */
export function ScheduleEditorDialog({
  open,
  onOpenChange,
  schedule,
  onSave,
  onSaved,
}: ScheduleEditorDialogProps) {
  const [form, setForm] = useState(emptyState());
  const [sessions, setSessions] = useState<MySessionOption[] | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(
      schedule
        ? {
            name: schedule.name,
            sessionId: schedule.sessionId,
            cron: schedule.cron,
            goal: schedule.goal,
            assignedAgent: schedule.assignedAgent ?? NONE_AGENT_VALUE,
          }
        : emptyState(),
    );
    setFieldErrors({});
    setFormError(null);

    let cancelled = false;
    Promise.all([
      listMySessionsForScheduleAction(),
      listEnabledAgentNamesForScheduleAction(),
    ])
      .then(([sessionRows, names]) => {
        if (cancelled) {
          return;
        }
        setSessions(sessionRows);
        setAgentNames(names);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        toast.error("We couldn't load your sessions.");
        setSessions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [open, schedule]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setFormError(null);

    try {
      const result = await onSave({
        name: form.name,
        sessionId: form.sessionId,
        cron: form.cron,
        goal: form.goal,
        assignedAgent:
          form.assignedAgent === NONE_AGENT_VALUE ? null : form.assignedAgent,
      });
      if (result.success) {
        toast.success(schedule ? "Schedule updated." : "Schedule created.");
        onSaved();
        onOpenChange(false);
      } else {
        setFieldErrors(result.fieldErrors ?? {});
        setFormError(result.error);
      }
    } catch {
      setFormError("That schedule could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const sessionsLoaded = sessions !== null;
  const title = schedule ? `Edit ${schedule.name}` : "New schedule";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Fires a task on a cron schedule — &ldquo;run the suite nightly and
            open a fix PR if it&apos;s red&rdquo; as a config row.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="grid gap-2">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, name: event.target.value }))
              }
              value={form.name}
            />
            {fieldErrors.name ? (
              <p className="text-error text-xs">{fieldErrors.name}</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="schedule-session">Session</Label>
            <Select
              disabled={!sessionsLoaded}
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, sessionId: value }))
              }
              value={form.sessionId}
            >
              <SelectTrigger id="schedule-session">
                <SelectValue
                  placeholder={
                    sessionsLoaded ? "Choose a session" : "Loading sessions…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {sessions?.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {session.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.sessionId ? (
              <p className="text-error text-xs">{fieldErrors.sessionId}</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="schedule-cron">Cron</Label>
            <Input
              id="schedule-cron"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, cron: event.target.value }))
              }
              placeholder="0 2 * * *"
              value={form.cron}
            />
            <p className="text-base-content/60 text-xs">
              A standard five-field cron expression, evaluated in UTC.
            </p>
            {fieldErrors.cron ? (
              <p className="text-error text-xs">{fieldErrors.cron}</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="schedule-goal">Goal</Label>
            <Textarea
              id="schedule-goal"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, goal: event.target.value }))
              }
              rows={4}
              value={form.goal}
            />
            {fieldErrors.goal ? (
              <p className="text-error text-xs">{fieldErrors.goal}</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="schedule-agent">Assigned agent</Label>
            <Select
              onValueChange={(value) =>
                setForm((prev) => ({ ...prev, assignedAgent: value }))
              }
              value={form.assignedAgent}
            >
              <SelectTrigger id="schedule-agent">
                <SelectValue placeholder="Orchestrator's default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_AGENT_VALUE}>
                  Orchestrator&apos;s default
                </SelectItem>
                {agentNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {formError ? (
            <p className="text-error text-sm" role="alert">
              {formError}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={saving}
              type="submit"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
