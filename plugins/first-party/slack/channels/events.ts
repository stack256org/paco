import type {
  PluginApi,
  PluginChannelModule,
  PluginChannelRequest,
  PluginChannelResponse,
} from "@paco/plugin-host";
import { isRecord } from "../lib/guards.ts";
import {
  isStoredThread,
  KV_DEFAULT_SESSION,
  KV_SIGNING_SECRET,
  kvChannelMapKey,
  kvChatTaskKey,
  kvThreadIndexKey,
  kvThreadKey,
} from "../lib/kv-keys.ts";
import { postThreadMessage } from "../lib/slack-api.ts";
import { verifySlackSignature } from "../lib/signature.ts";

/** Slack's Events API: url_verification handshake, and app_mention -> task.
 * https://api.slack.com/apis/events-api */

const TITLE_MAX_LENGTH = 80;

/** Present on a retried delivery (Slack resends when it doesn't see a fast
 * 200). Re-running app_mention handling on a retry would create a second
 * task for one mention, so a retry is acknowledged without reprocessing. */
const RETRY_HEADER = "x-slack-retry-num";

/** Strips one or more leading `<@USERID>` mentions (and the whitespace
 * around them) so `goal`/`title` are the actual instruction, not the
 * mention Slack renders inline with it. */
function stripMentionPrefix(text: string): string {
  return text.replace(/^(?:\s*<@[A-Za-z0-9]+>\s*)+/, "").trim();
}

async function resolveSessionId(
  api: PluginApi,
  channel: string,
): Promise<string | undefined> {
  const mapped = await api.kv.get(kvChannelMapKey(channel));
  if (typeof mapped === "string" && mapped.length > 0) {
    return mapped;
  }
  const fallback = await api.kv.get(KV_DEFAULT_SESSION);
  return typeof fallback === "string" && fallback.length > 0
    ? fallback
    : undefined;
}

/**
 * A mention posted inside a thread this plugin already started a task for:
 * route it into that task's own chat via `messages:post` instead of
 * spawning a duplicate task for the same conversation. Returns `true` when
 * it did, so the caller skips task creation.
 */
async function routeToExistingTask(
  api: PluginApi,
  channel: string,
  threadTs: string,
  goal: string,
): Promise<boolean> {
  const existingTaskId = await api.kv.get(kvThreadIndexKey(channel, threadTs));
  if (typeof existingTaskId !== "string") {
    return false;
  }
  const stored = await api.kv.get(kvThreadKey(existingTaskId));
  if (!(isStoredThread(stored) && stored.chatId)) {
    return false;
  }

  // Paco's `messages:post` plugin capability (posts into a Paco chat), not
  // the browser's `window.postMessage` -- there is no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  await api.postMessage({ chatId: stored.chatId, text: goal });
  await postThreadMessage(
    api,
    channel,
    threadTs,
    `Added to task ${existingTaskId}.`,
  );
  return true;
}

async function createTaskFromMention(
  api: PluginApi,
  channel: string,
  ts: string,
  rootThreadTs: string,
  goal: string,
  sessionId: string,
): Promise<void> {
  const result = await api.tasks.create({
    sessionId,
    title: goal.slice(0, TITLE_MAX_LENGTH),
    goal,
    autoStart: true,
  });

  const writes: Array<Promise<void>> = [
    api.kv.set(kvThreadKey(result.taskId), {
      channel,
      ts,
      threadTs: rootThreadTs,
      chatId: result.chatId,
    }),
    api.kv.set(kvThreadIndexKey(channel, rootThreadTs), result.taskId),
  ];
  if (result.chatId) {
    writes.push(api.kv.set(kvChatTaskKey(result.chatId), result.taskId));
  }
  await Promise.all(writes);

  const ackText = result.error
    ? `Created task ${result.taskId}, but could not start it: ${result.error}`
    : `Started task ${result.taskId}.`;
  await postThreadMessage(api, channel, rootThreadTs, ackText);
}

async function handleAppMention(
  event: Record<string, unknown>,
  api: PluginApi,
): Promise<void> {
  const channel = typeof event.channel === "string" ? event.channel : undefined;
  const ts = typeof event.ts === "string" ? event.ts : undefined;
  const text = typeof event.text === "string" ? event.text : "";
  const threadTs =
    typeof event.thread_ts === "string" ? event.thread_ts : undefined;

  if (!(channel && ts)) {
    api.log("warn", "slack: app_mention event missing channel or ts");
    return;
  }

  const goal = stripMentionPrefix(text);
  const rootThreadTs = threadTs ?? ts;

  if (goal.length === 0) {
    await postThreadMessage(
      api,
      channel,
      rootThreadTs,
      "Mention me with something to do and I will start a task.",
    );
    return;
  }

  if (threadTs && (await routeToExistingTask(api, channel, threadTs, goal))) {
    return;
  }

  const sessionId = await resolveSessionId(api, channel);
  if (!sessionId) {
    await postThreadMessage(
      api,
      channel,
      rootThreadTs,
      "No session is configured for this channel. Ask an admin to run slack_setup.",
    );
    return;
  }

  await createTaskFromMention(api, channel, ts, rootThreadTs, goal, sessionId);
}

async function handle(
  request: PluginChannelRequest,
  api: PluginApi,
): Promise<PluginChannelResponse> {
  const signingSecret = await api.kv.get(KV_SIGNING_SECRET);
  if (typeof signingSecret !== "string" || signingSecret.length === 0) {
    return {
      status: 401,
      body: { error: "Slack is not configured yet: run slack_setup first" },
    };
  }

  const verification = verifySlackSignature(
    request.headers,
    request.rawBody,
    signingSecret,
  );
  if (!verification.ok) {
    return { status: 401, body: { error: verification.reason } };
  }

  const body = request.body;
  if (!isRecord(body)) {
    return { status: 400, body: { error: "expected a JSON body" } };
  }

  if (body.type === "url_verification") {
    const challenge = body.challenge;
    return typeof challenge === "string"
      ? { status: 200, body: { challenge } }
      : { status: 400, body: { error: "missing challenge" } };
  }

  if (body.type === "event_callback") {
    if (request.headers[RETRY_HEADER]) {
      return { status: 200, body: {} };
    }
    const event = body.event;
    if (isRecord(event) && event.type === "app_mention") {
      await handleAppMention(event, api);
    }
    return { status: 200, body: {} };
  }

  // Slack sends other event_callback-adjacent request types over time
  // (e.g. `app_rate_limited`); ack anything else this plugin doesn't
  // specifically handle rather than erroring on it.
  return { status: 200, body: {} };
}

const eventsChannel: PluginChannelModule = { name: "events", handle };

export default eventsChannel;
