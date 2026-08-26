import { isRecord } from "./guards.ts";

/**
 * `storage:kv` key names and shapes this plugin writes/reads, per the plan
 * (Section 6 Task 3). Centralized here so `channels/events.ts`,
 * `tools/slack-setup.ts` and `hooks/task-updates.ts` never drift on a key's
 * exact spelling.
 */

/**
 * Set once by `tools/slack-setup.ts`; read by `channels/events.ts` to verify
 * Slack's v0 request signature.
 *
 * Written with `kv.setSecret`, not `kv.set` — `plugin_kv` is a plaintext
 * `jsonb` column, and this is the secret that authenticates every inbound
 * webhook. `kv.get` unseals it transparently.
 */
export const KV_SIGNING_SECRET = "slack:signing-secret";

/**
 * Set once by `tools/slack-setup.ts`; read whenever this plugin calls the
 * Slack Web API.
 *
 * Written with `kv.setSecret` for the same reason as the signing secret: in
 * the clear, a `select *` on `plugin_kv` yields a live Slack workspace token.
 */
export const KV_BOT_TOKEN = "slack:bot-token";

/**
 * Set once by `tools/slack-setup.ts` from `auth.test`'s `team_id`; the ONE
 * Slack workspace this installation will act for.
 *
 * A valid v0 signature proves a request came from Slack, not that it came
 * from a workspace this operator installed the app into. Without this,
 * `channels/events.ts` would act on any signature-valid `app_mention`.
 * Absent means not configured, and not configured means refuse — never
 * "any workspace".
 */
export const KV_TEAM_ID = "slack:team-id";

/**
 * Optional: the Slack user ids allowed to start work, as a string array.
 *
 * Absent or empty means every member of a mapped channel may — which is
 * already a deliberate grant, since a channel only routes anywhere at all
 * once an admin has mapped it. Present means only these people.
 */
export const KV_ALLOWED_USERS = "slack:allowed-users";

/**
 * Slack channel id -> Paco session id, set by `tools/slack-setup.ts`'s
 * `channelMap` input.
 *
 * This mapping IS the channel authorization: a mention in a channel with no
 * entry here starts nothing. There is deliberately no catch-all — see
 * `channels/events.ts`'s `resolveSessionId`.
 */
export function kvChannelMapKey(slackChannelId: string): string {
  return `slack:channel-map:${slackChannelId}`;
}

/** Task id -> the Slack thread it should post updates into. */
export function kvThreadKey(taskId: string): string {
  return `slack:thread:${taskId}`;
}

/**
 * (Slack channel, root thread ts) -> task id. Lets a follow-up @-mention
 * inside a thread this plugin already started a task for be routed into
 * that task's existing chat (via `messages:post`) instead of creating a
 * second task for the same conversation.
 */
export function kvThreadIndexKey(channel: string, threadTs: string): string {
  return `slack:thread-index:${channel}:${threadTs}`;
}

/**
 * Paco chat id -> task id. `turn/end` session events carry a chat id but no
 * task id (packages/agent-backend/events.ts), so `hooks/task-updates.ts`
 * needs this reverse index to know a turn belongs to a task with a Slack
 * thread on file.
 */
export function kvChatTaskKey(chatId: string): string {
  return `slack:chat-task:${chatId}`;
}

/**
 * What `slack:thread:<taskId>` stores: enough to reply into the right
 * Slack thread, and -- when the task got a chat started -- to route
 * follow-up mentions and `turn/end` updates back to it.
 */
export interface StoredThread {
  channel: string;
  /** The `ts` of the Slack message that created this task. */
  ts: string;
  /** The thread root's `ts` -- itself, for a new top-level mention, or the
   * mention's own `thread_ts` when it started inside an existing thread. */
  threadTs: string;
  /** Absent when `tasks:create` succeeded but `autoStart` did not (see
   * `PluginTaskCreateResult.error`) -- there is then no chat to route a
   * reply or a `turn/end` update to. */
  chatId?: string;
}

export function isStoredThread(value: unknown): value is StoredThread {
  return (
    isRecord(value) &&
    typeof value.channel === "string" &&
    typeof value.ts === "string" &&
    typeof value.threadTs === "string" &&
    (value.chatId === undefined || typeof value.chatId === "string")
  );
}
