import "server-only";

import { generateId } from "ai";
import { nanoid } from "nanoid";
import { start } from "workflow/api";
import { runAgentWorkflow } from "@/app/workflows/chat";
import type { Task } from "@/lib/db/schema";
import {
  claimChatActiveStreamId,
  createChat,
  deleteChat,
  getSessionById,
} from "@/lib/db/sessions";
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
export function buildTaskPrompt(task: Task, parent?: Task | null): string {
  const sections = [task.goal];

  if (parent) {
    sections.push("", `Parent task: "${parent.title}" — ${parent.goal}`);
  }

  if (task.assignedAgent) {
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
 * logic that materializes lazily the first time a chat's workflow runs.
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
 *   itself can fail (the `start()` call throws, or claiming the chat's
 *   active-stream slot fails). Here the task is transitioned on to `failed`
 *   with the error recorded as `resultSummary`, rather than left stuck in
 *   `running` with no executor behind it. A claim failure also cancels the
 *   run it lost the race to keep, so a workflow never keeps executing after
 *   its task has been marked failed.
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

  const session = await getSessionById(node.sessionId);
  if (!session) {
    return { ok: false, error: `Session "${node.sessionId}" not found` };
  }

  const parent = node.parentTaskId
    ? ((await getTask(organizationId, node.parentTaskId)) ?? null)
    : null;

  const preferences = await getUserPreferences(session.userId);
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
    const run = await start(runAgentWorkflow, [
      {
        messages: [
          {
            id: generateId(),
            role: "user" as const,
            parts: [
              { type: "text" as const, text: buildTaskPrompt(node, parent) },
            ],
          },
        ],
        chatId: chat.id,
        sessionId: node.sessionId,
        userId: session.userId,
        requestUrl: "internal://tasks/start",
        authSession: null,
        assistantId: generateId(),
        maxSteps: opts?.maxTurns ?? TASK_DEFAULT_MAX_TURNS,
      },
    ]);

    const claimed = await claimChatActiveStreamId(chat.id, run.runId);
    if (!claimed) {
      await cancelRun(run.runId);
      throw new Error(`Chat "${chat.id}" already has an active run`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await transitionTaskStatus(organizationId, node.id, "failed", {
        resultSummary: message,
      });
    } catch (transitionError) {
      console.error(
        `Failed to transition task "${node.id}" to "failed":`,
        transitionError,
      );
    }
    return { ok: false, error: message };
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
 * Best-effort cancellation of a run that lost the active-stream claim —
 * mirrors `submitChatMessage`'s identical cleanup so a workflow never keeps
 * executing after `startTask` has already decided to fail its task.
 */
async function cancelRun(runId: string): Promise<void> {
  try {
    const { getRun } = await import("workflow/api");
    getRun(runId).cancel();
  } catch (error) {
    console.error(`Failed to cancel run "${runId}":`, error);
  }
}
