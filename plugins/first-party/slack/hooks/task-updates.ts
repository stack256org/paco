import type { PluginApi, PluginSessionEvent } from "@paco/plugin-host";
import { isRecord } from "../lib/guards.ts";
import { isStoredThread, kvChatTaskKey, kvThreadKey } from "../lib/kv-keys.ts";
import { postThreadMessage } from "../lib/slack-api.ts";

/**
 * `events:subscribe` hook: mirrors a task's lifecycle back into the Slack
 * thread `channels/events.ts` created it from.
 *
 * Session events arrive as `unknown` (this plugin never imports
 * `@paco/agent-backend` -- its event union is app-internal, not part of the
 * plugin API surface), so every shape used here is narrowed by hand rather
 * than trusted.
 */

interface TaskStatusEvent {
  type: "task/status";
  taskId: string;
  from: string;
  to: string;
}

function isTaskStatusEvent(value: unknown): value is TaskStatusEvent {
  return (
    isRecord(value) &&
    value.type === "task/status" &&
    typeof value.taskId === "string" &&
    typeof value.from === "string" &&
    typeof value.to === "string"
  );
}

interface TurnEndEvent {
  type: "turn/end";
  finishReason: string;
  isError: boolean;
}

function isTurnEndEvent(value: unknown): value is TurnEndEvent {
  return (
    isRecord(value) &&
    value.type === "turn/end" &&
    typeof value.finishReason === "string" &&
    typeof value.isError === "boolean"
  );
}

const TERMINAL_STATUSES = new Set(["done", "failed"]);

async function handleTaskStatus(
  event: TaskStatusEvent,
  api: PluginApi,
): Promise<void> {
  const stored = await api.kv.get(kvThreadKey(event.taskId));
  if (!isStoredThread(stored)) {
    return;
  }

  const text = TERMINAL_STATUSES.has(event.to)
    ? `Task ${event.taskId} finished: ${event.from} -> ${event.to}.`
    : `Task ${event.taskId}: ${event.from} -> ${event.to}.`;
  await postThreadMessage(api, stored.channel, stored.threadTs, text);
}

/**
 * KNOWN GAP: `turn/end` (packages/agent-backend/events.ts) carries no task
 * id and no result-summary text -- only `finishReason`/`isError`. The
 * task's real `resultSummary` column (apps/web/lib/db/tasks.ts, set by
 * `runTaskCompletionStep`/`runReviewerGate`) is never echoed into a session
 * event, and this plugin has no capability to read it back out of the
 * database directly -- `net:fetch` is restricted to `slack.com`, and there
 * is no `tasks:read` capability. So this handler cannot post the task's
 * actual summary; it posts the turn's outcome instead, which is the closest
 * signal available, and correlates a `turn/end`'s chat id back to a task
 * purely through kv state this plugin wrote itself
 * (`slack:chat-task:<chatId>`, from `channels/events.ts`). See
 * docs/plugins.md.
 */
async function handleTurnEnd(
  event: TurnEndEvent,
  chatId: string,
  api: PluginApi,
): Promise<void> {
  if (event.isError) {
    // The task/status transition to "failed" already reports this.
    return;
  }

  const taskId = await api.kv.get(kvChatTaskKey(chatId));
  if (typeof taskId !== "string") {
    return;
  }

  const stored = await api.kv.get(kvThreadKey(taskId));
  if (!isStoredThread(stored)) {
    return;
  }

  await postThreadMessage(
    api,
    stored.channel,
    stored.threadTs,
    `Task ${taskId}: turn finished (${event.finishReason}).`,
  );
}

async function onSessionEvent(
  payload: PluginSessionEvent,
  api: PluginApi,
): Promise<void> {
  const { event, chatId } = payload;
  if (isTaskStatusEvent(event)) {
    await handleTaskStatus(event, api);
    return;
  }
  if (isTurnEndEvent(event)) {
    await handleTurnEnd(event, chatId, api);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const taskUpdatesHook = (api: PluginApi): void => {
  api.events.subscribe((payload) => {
    onSessionEvent(payload, api).catch((error: unknown) => {
      api.log("error", `slack task-updates hook failed: ${describe(error)}`);
    });
  });
};

export default taskUpdatesHook;
