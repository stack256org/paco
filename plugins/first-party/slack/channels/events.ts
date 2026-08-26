import type {
  PluginApi,
  PluginChannelModule,
  PluginChannelRequest,
  PluginChannelResponse,
} from "@paco/plugin-host";
import { isRecord, isStringArray } from "../lib/guards.ts";
import {
  isStoredThread,
  KV_ALLOWED_USERS,
  KV_SIGNING_SECRET,
  KV_TEAM_ID,
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

/**
 * The session a channel is wired to, or `undefined`.
 *
 * There is deliberately NO fallback to a catch-all session. This handler
 * ends in `tasks.create({autoStart: true})` — an agent turn on the
 * operator's own host — so the question "may this channel start work?" has
 * to have been answered by a person, once, in advance.
 *
 * A default session answered it implicitly for every channel at once, which
 * made "somebody invited the bot into a channel" equivalent to "somebody
 * may run an agent on the operator's machine". Inviting a bot is not an
 * authorization decision an operator makes; mapping a channel is. So an
 * unmapped channel routes nowhere, and says so.
 */
async function resolveSessionId(
  api: PluginApi,
  channel: string,
): Promise<string | undefined> {
  const mapped = await api.kv.get(kvChannelMapKey(channel));
  return typeof mapped === "string" && mapped.length > 0 ? mapped : undefined;
}

/**
 * Whether this `event_callback` came from the workspace this installation
 * was set up for.
 *
 * The v0 signature authenticates Slack, not a workspace: any workspace the
 * app is installed into signs with the SAME app signing secret. Without this
 * check, anyone who could get the bot into any workspace could reach the
 * handler below.
 *
 * Fails closed in both directions — an unconfigured installation (no stored
 * team id) and an event that names no workspace are both refused, never
 * treated as a match.
 */
async function isConfiguredWorkspace(
  api: PluginApi,
  body: Record<string, unknown>,
): Promise<boolean> {
  const configured = await api.kv.get(KV_TEAM_ID);
  if (typeof configured !== "string" || configured.length === 0) {
    api.log(
      "error",
      "slack: no workspace is bound; run slack_setup before events can be accepted",
    );
    return false;
  }
  return body.team_id === configured;
}

/**
 * Whether `userId` may start work, given the optionally configured
 * allowlist.
 *
 * No allowlist means every member of a MAPPED channel may — that channel
 * having been mapped by an admin is itself the grant. A stored value that
 * is not a string array is treated as no allowlist rather than as an empty
 * one, so a corrupted key cannot lock the operator out of their own bot;
 * the mapped-channel gate still stands in front of it either way.
 */
async function isAllowedUser(api: PluginApi, userId: string): Promise<boolean> {
  const stored = await api.kv.get(KV_ALLOWED_USERS);
  if (!isStringArray(stored) || stored.length === 0) {
    return true;
  }
  return stored.includes(userId);
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

  // Authored by a bot rather than a person. Answering would let two bots
  // mention each other into an unbounded run of agent turns, so this one is
  // dropped in silence — a reply is exactly what must not happen.
  if (typeof event.bot_id === "string") {
    api.log(
      "warn",
      `slack: ignoring app_mention authored by bot ${event.bot_id}`,
    );
    return;
  }

  const user = typeof event.user === "string" ? event.user : undefined;
  if (!user) {
    api.log("warn", "slack: ignoring app_mention with no author to authorize");
    return;
  }
  if (!(await isAllowedUser(api, user))) {
    api.log("warn", `slack: ${user} is not on the Slack allowlist`);
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
      "This channel is not connected to a Paco session. Ask an admin to map it with slack_setup.",
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
    // Authorization before deduplication: a retry of an event this
    // installation was never entitled to act on is still not ours.
    if (!(await isConfiguredWorkspace(api, body))) {
      return {
        status: 403,
        body: {
          error: "this event is not from the configured Slack workspace",
        },
      };
    }

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
