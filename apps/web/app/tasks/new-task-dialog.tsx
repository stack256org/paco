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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/toast";
import {
  createTaskAction,
  listEnabledAgentNamesAction,
  listMySessionsForTaskAction,
  type MySessionOption,
} from "./actions";

export interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create, so the board can refresh its list. */
  onCreated: () => void;
}

const NONE_AGENT_VALUE = "__none__";

/**
 * Create one task, or hand a goal to the planner instead.
 *
 * The session picker is scoped to the caller's own sessions
 * (`listMySessionsForTaskAction`) — a task always runs in some session's
 * repo, and this is the same set `createTaskAction` itself re-checks
 * server-side, so a submission here can only ever name a session the caller
 * already owns. Flipping "Plan this goal" hides Title and Assigned agent:
 * the planner derives its own root title from the goal
 * (`truncateTitle` in `lib/tasks/planner.ts`) and assigns each generated
 * subtask its own agent, so neither field applies to the plan as a whole.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  onCreated,
}: NewTaskDialogProps) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [assignedAgent, setAssignedAgent] = useState(NONE_AGENT_VALUE);
  const [planThisGoal, setPlanThisGoal] = useState(false);
  const [sessions, setSessions] = useState<MySessionOption[] | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle("");
    setGoal("");
    setSessionId("");
    setAssignedAgent(NONE_AGENT_VALUE);
    setPlanThisGoal(false);
    setError(null);

    let cancelled = false;
    Promise.all([listMySessionsForTaskAction(), listEnabledAgentNamesAction()])
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
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await createTaskAction({
        title,
        goal,
        sessionId,
        planThisGoal,
        assignedAgent:
          !planThisGoal && assignedAgent !== NONE_AGENT_VALUE
            ? assignedAgent
            : null,
      });

      if (result.ok) {
        toast.success(
          planThisGoal ? "Goal handed to the planner." : "Task created.",
        );
        onCreated();
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    } catch {
      setError("That task could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  const sessionsLoaded = sessions !== null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Add work to the board, or hand a goal to the planner to break it
            down for you.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className="flex items-center justify-between gap-2 rounded-lg border border-base-300 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Plan this goal</p>
              <p className="text-base-content/60 text-xs">
                Decompose the goal into a task tree instead of creating one task
                directly.
              </p>
            </div>
            <Switch checked={planThisGoal} onCheckedChange={setPlanThisGoal} />
          </div>

          {planThisGoal ? null : (
            <div className="grid gap-2">
              <Label htmlFor="task-title">Title</Label>
              <Input
                id="task-title"
                onChange={(event) => setTitle(event.target.value)}
                required
                value={title}
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="task-goal">Goal</Label>
            <Textarea
              id="task-goal"
              onChange={(event) => setGoal(event.target.value)}
              required
              rows={4}
              value={goal}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="task-session">Session</Label>
            <Select
              disabled={!sessionsLoaded}
              onValueChange={setSessionId}
              value={sessionId}
            >
              <SelectTrigger id="task-session">
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
            {sessionsLoaded && sessions?.length === 0 ? (
              <p className="text-base-content/60 text-xs">
                Start a session first — a task always runs in one.
              </p>
            ) : null}
          </div>

          {planThisGoal ? null : (
            <div className="grid gap-2">
              <Label htmlFor="task-agent">Assigned agent</Label>
              <Select onValueChange={setAssignedAgent} value={assignedAgent}>
                <SelectTrigger id="task-agent">
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
          )}

          {error ? (
            <p className="text-error text-sm" role="alert">
              {error}
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
              disabled={submitting || !sessionId || !goal.trim()}
              type="submit"
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
