import "server-only";

import { generateId } from "ai";
import { nanoid } from "nanoid";
import { submitChatMessage } from "@/lib/chat/submit-message";
import type { Task } from "@/lib/db/schema";
import { getRoster } from "@/lib/db/roster";
import { createChat, deleteChat, getSessionById } from "@/lib/db/sessions";
import {
  getTask,
  TaskTransitionError,
  taskTree,
  transitionTaskStatus,
} from "@/lib/db/tasks";
import { getUserPreferences } from "@/lib/db/user-preferences";

/**
 * Renders the prompt an executor turn sees for a task.
 *
 * Always leads with the task's own goal — the executor is only ever handed
 * its own goal text (planner tasks are self-contained by construction, see
 * `planGoal`). `parent` adds a line of context when the task was decomposed
 * from a bigger one, so the executor understands what it is a part of
 * without being handed the parent's full scope. `task.assignedAgent` adds an
 * explicit delegation instruction so the orchestrator routes the work to
 * that roster subagent by name instead of handling it inline.
 */
export function buildTaskPrompt(
  task: Task,
  parent?: Task | null,
  /**
   * The subagent names actually available to this turn. Omit to skip the
   * check — callers that already know the roster should pass it.
   *
   * `assignedAgent` is validated against the roster when a task or schedule
   * is SAVED, but a roster entry can be disabled or renamed afterwards and
   * nothing revisits the rows already naming it. A schedule then keeps
   * firing with a stale name, and without this check the executor is told
   * to "delegate this work to the X subagent" for an X that no longer
   * exists — an instruction it cannot follow and cannot diagnose. Dropping
   * the line degrades to "do the work yourself", which is what the task
   * actually wants.
   */
  availableAgents?: ReadonlySet<string>,
): string {
  const sections = [task.goal];

  if (parent) {
    sections.push("", `Parent task: "${parent.title}" — ${parent.goal}`);
  }

  if (
    task.assignedAgent &&
    (availableAgents === undefined || availableAgents.has(task.assignedAgent))
  ) {
    sections.push(
      "",
      `Delegate this work to the "${task.assignedAgent}" subagent.`,
    );
  }

  return sections.join("\n");
}

export type StartTaskOptions = {
  maxTurns?: number;
};

export type StartTaskResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

/**
 * An unattended task has no human watching the turn count, so it gets a
 * hard cap rather than the CLI's own (much larger) default: 200 turns is
 * generous for a single decomposed unit of work while still guaranteeing a
 * runaway task fails loudly instead of burning turns indefinitely.
 */
export const TASK_DEFAULT_MAX_TURNS = 200;

/**
 * Starts a `todo` task: creates its chat, transitions it to `running`, and
 * kicks off the executor workflow with `buildTaskPrompt(task)` as the first
 * message.
 *
 * A task with children is a grouping node the planner created to hold a
 * decomposed tree, never a unit of work itself — it is rejected before
 * anything is created. The chat is created with the exact same call the
 * UI's "new chat" route makes (`createChat` from `lib/db/sessions`, with the
 * session's default model), so this pipeline never duplicates the worktree
 * logic that materializes lazily the first time a chat's workflow runs. The
 * workflow itself is kicked off through `submitChatMessage` — the same
 * function the browser chat route and plugin message posting both go
 * through — so starting a task's turn, claiming its active-stream slot, and
 * cancelling a run that lost that claim all stay one implementation instead
 * of three drifting copies.
 *
 * Two things can go wrong after the chat exists, and they are handled
 * differently because the task is in a different state for each:
 *
 * - The `todo -> running` transition itself can lose a race to another
 *   caller starting the same task concurrently (`transitionTaskStatus`
 *   throws `TaskTransitionError`). The task was never actually claimed by
 *   the chat we just created, so that chat is deleted again (it never got
 *   far enough to acquire a worktree) rather than left as an orphan row.
 * - Once the task *is* running under this chat, starting the workflow
 *   itself can fail (`submitChatMessage` throws, or returns any outcome
 *   other than `"streaming"` — a freshly created chat has no active stream
 *   of its own, so `"archived"`/`"buffer-failed"`/`"conflict"` all mean the
 *   turn never actually started). Here the task is transitioned on to
 *   `failed` with the error recorded as `resultSummary`, rather than left
 *   stuck in `running` with no executor behind it.
 */
export async function startTask(
  organizationId: string,
  taskId: string,
  opts?: StartTaskOptions,
): Promise<StartTaskResult> {
  const node = await taskTree(organizationId, taskId);
  if (!node) {
    return { ok: false, error: `Task "${taskId}" not found` };
  }
  if (node.children.length > 0) {
    return {
      ok: false,
      error: `Task "${taskId}" has children and cannot be started directly`,
    };
  }
  if (node.status !== "todo") {
    return {
      ok: false,
      error: `Task "${taskId}" is not "todo" (currently "${node.status}")`,
    };
  }
  if (!node.sessionId) {
    return {
      ok: false,
      error: `Task "${taskId}" has no session and cannot be started`,
    };
  }

  const session = await getSessionById(node.sessionId);
  if (!session) {
    return { ok: false, error: `Session "${node.sessionId}" not found` };
  }

  const parent = node.parentTaskId
    ? ((await getTask(organizationId, node.parentTaskId)) ?? null)
    : null;

  const preferences = await getUserPreferences(session.userId);
  /*
   * The roster as it stands NOW, not as it stood when the task was saved.
   * `assignedAgent` is validated on save, but disabling or renaming a roster
   * entry afterwards does not revisit the tasks and schedules already naming
   * it — a schedule in particular keeps firing indefinitely with a name that
   * no longer resolves. Read once here and hand it to `buildTaskPrompt`, so a
   * stale name degrades to "do the work yourself" instead of instructing the
   * executor to delegate to a subagent that does not exist.
   */
  const availableAgents = new Set(Object.keys(await getRoster(organizationId)));
  const chat = await createChat({
    id: nanoid(),
    sessionId: node.sessionId,
    title: node.title,
    modelId: preferences.defaultModelId,
  });

  try {
    await transitionTaskStatus(organizationId, node.id, "running", {
      chatId: chat.id,
    });
  } catch (error) {
    await deleteOrphanChat(chat.id);
    if (error instanceof TaskTransitionError) {
      return { ok: false, error: "task was started by someone else" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }

  try {
    const outcome = await submitChatMessage({
      chatId: chat.id,
      sessionId: node.sessionId,
      userId: session.userId,
      messages: [
        {
          id: generateId(),
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: buildTaskPrompt(node, parent, availableAgents),
            },
          ],
        },
      ],
      requestUrl: "internal://tasks/start",
      authSession: null,
      sessionStatus: session.status,
      activeStreamId: chat.activeStreamId ?? null,
      maxSteps: opts?.maxTurns ?? TASK_DEFAULT_MAX_TURNS,
    });

    if (outcome.kind !== "streaming") {
      throw new Error(
        `Failed to start task workflow: chat submission returned "${outcome.kind}"`,
      );
    }
  } catch (error) {
    return await failTask(organizationId, node.id, error);
  }

  return { ok: true, chatId: chat.id };
}

/**
 * Deletes a chat this call created but that never became a task's chat of
 * record — the task's `todo -> running` transition lost a race before the
 * workflow was ever kicked off, so no worktree exists for it yet and a
 * plain row delete is all cleanup requires. Best-effort: a failure here is
 * logged rather than surfaced, since the caller already has a definite
 * answer (the race loss) to return.
 */
async function deleteOrphanChat(chatId: string): Promise<void> {
  try {
    await deleteChat(chatId);
  } catch (error) {
    console.error(`Failed to delete orphaned chat "${chatId}":`, error);
  }
}

/**
 * Moves a task from `running` to `failed` after its workflow failed to
 * start, recording the error as `resultSummary`. The transition itself is
 * best-effort: if it fails too, the caller still gets a definite `{ok:
 * false}` rather than an unhandled rejection on top of the original error.
 */
async function failTask(
  organizationId: string,
  taskId: string,
  error: unknown,
): Promise<StartTaskResult> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await transitionTaskStatus(organizationId, taskId, "failed", {
      resultSummary: message,
    });
  } catch (transitionError) {
    console.error(
      `Failed to transition task "${taskId}" to "failed":`,
      transitionError,
    );
  }
  return { ok: false, error: message };
}
