"use client";

import { type FormEvent, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { listMySessionsForTaskAction, type MySessionOption } from "./actions";

export interface UnblockTaskDialogProps {
  /** The blocked task being unblocked, or `null` when nothing is open. */
  task: { id: string; title: string; goal: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen session; the board owns the action and its toasts. */
  onConfirm: (sessionId: string) => void;
  submitting: boolean;
}

/**
 * Picks the session a never-started blocked task should run in.
 *
 * Every proposal task — a reflection's skill proposal
 * (`lib/memory/reflect.ts`), an org-memory promotion
 * (`lib/memory/promote.ts`) — is filed `blocked` with no session at all,
 * because the thing that filed it was org-wide and had no repository in
 * hand. Those are the majority of what the Blocked column holds, so
 * "Unblock" has to be able to answer the one question they leave open
 * rather than refusing them: which repository does this work belong in.
 *
 * The picker is the caller's own sessions (`listMySessionsForTaskAction`),
 * the same set `NewTaskDialog` offers and the same set
 * `unblockTaskAction` re-checks server-side. The task's goal is shown
 * because a proposal's goal IS the proposal — a human deciding whether to
 * act on it needs to read it here, not go hunting for it.
 */
export function UnblockTaskDialog({
  task,
  onOpenChange,
  onConfirm,
  submitting,
}: UnblockTaskDialogProps) {
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState<MySessionOption[] | null>(null);
  const open = task !== null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setSessionId("");

    let cancelled = false;
    listMySessionsForTaskAction()
      .then((rows) => {
        if (!cancelled) {
          setSessions(rows);
        }
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !sessionId) {
      return;
    }
    onConfirm(sessionId);
  }

  const sessionsLoaded = sessions !== null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Unblock task</DialogTitle>
          <DialogDescription>
            This task has never run and has no session yet. Choose the one it
            should run in — it starts as soon as you confirm.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {task ? (
            <div className="rounded-lg border border-base-300 px-3 py-2">
              <p className="font-medium text-sm">{task.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-base-content/60 text-xs">
                {task.goal}
              </p>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="unblock-session">Session</Label>
            <Select
              disabled={!sessionsLoaded}
              onValueChange={setSessionId}
              value={sessionId}
            >
              <SelectTrigger id="unblock-session">
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
              disabled={submitting || !sessionId}
              type="submit"
            >
              {submitting ? "Starting…" : "Unblock and start"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
