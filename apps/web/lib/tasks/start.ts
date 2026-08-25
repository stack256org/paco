import "server-only";

import { generateId } from "ai";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { start } from "workflow/api";
import { runAgentWorkflow } from "@/app/workflows/chat";
import { db } from "@/lib/db/client";
import { type Task, tasks } from "@/lib/db/schema";
import {
  claimChatActiveStreamId,
  createChat,
  getSessionById,
} from "@/lib/db/sessions";
import { getTask, taskTree, transitionTaskStatus } from "@/lib/db/tasks";
import { getUserPreferences } from "@/lib/db/user-preferences";

/**
 * Looks up which organization owns a task, given only its id.
 *
 * `getTask`/`taskTree`/`transitionTaskStatus` are all organization-scoped —
 * a caller must already know the organization before it can touch a task,
 * so a task id from another organization is indistinguishable from one that
 * does not exist. `startTask`'s contract only takes a task id (its callers,
 * e.g. a task-board action, have already resolved the task within their own
 * organization), so this one-column lookup bridges the gap: it establishes
 * the organization from the row itself, and every call after this one goes
 * through the organization-scoped helpers with that value — nothing here
 * accepts an organization id from the caller.
 */
async function organizationIdForTask(
  taskId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ organizationId: tasks.organizationId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  return row?.organizationId;
}

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
 * If starting the workflow itself fails (the `start()` call throws, or
 * claiming the chat's active-stream slot fails), the task is transitioned
 * back to `failed` with the error recorded as `resultSummary` rather than
 * left stuck in `running` with no executor behind it.
 */
export async function startTask(
  taskId: string,
  opts?: StartTaskOptions,
): Promise<StartTaskResult> {
  const organizationId = await organizationIdForTask(taskId);
  if (!organizationId) {
    return { ok: false, error: `Task "${taskId}" not found` };
  }

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
    ? ((await getTask(node.organizationId, node.parentTaskId)) ?? null)
    : null;

  const preferences = await getUserPreferences(session.userId);
  const chat = await createChat({
    id: nanoid(),
    sessionId: node.sessionId,
    title: node.title,
    modelId: preferences.defaultModelId,
  });

  await transitionTaskStatus(node.organizationId, node.id, "running", {
    chatId: chat.id,
  });

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
        maxSteps: opts?.maxTurns,
      },
    ]);

    const claimed = await claimChatActiveStreamId(chat.id, run.runId);
    if (!claimed) {
      throw new Error(`Chat "${chat.id}" already has an active run`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitionTaskStatus(node.organizationId, node.id, "failed", {
      resultSummary: message,
    });
    return { ok: false, error: message };
  }

  return { ok: true, chatId: chat.id };
}
