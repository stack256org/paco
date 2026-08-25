import type { PluginApi, PluginToolModule } from "@paco/plugin-host";
import { isRecord, isStringArray } from "../lib/guards.ts";
import {
  KV_ALLOWED_USERS,
  KV_BOT_TOKEN,
  KV_SIGNING_SECRET,
  KV_TEAM_ID,
  kvChannelMapKey,
} from "../lib/kv-keys.ts";
import { slackAuthTest } from "../lib/slack-api.ts";

/**
 * One-time Slack setup, run by an admin from a chat (a model-facing tool,
 * not an HTTP endpoint -- the worker has no env, so `appUrl` arrives as
 * input rather than being read from one).
 */

export interface SlackSetupInput {
  botToken: string;
  signingSecret: string;
  appUrl: string;
  /**
   * Slack channel id -> Paco session id. Required and non-empty: a mention
   * only starts work in a channel listed here, and there is no catch-all
   * session behind it (see `channels/events.ts`'s `resolveSessionId`).
   */
  channelMap: Record<string, string>;
  /** Optional: narrow further, to these Slack user ids only. */
  allowedUserIds?: string[];
}

export interface SlackSetupResult {
  ok: boolean;
  webhookUrl?: string;
  team?: string;
  /** The workspace this installation is now bound to. */
  teamId?: string;
  botUserId?: string;
  error?: string;
}

function parseChannelMap(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [slackChannelId, sessionId] of Object.entries(raw)) {
    if (
      slackChannelId.length === 0 ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return undefined;
    }
    normalized[slackChannelId] = sessionId;
  }
  // An empty map is not "map nothing yet" — it is a setup that authorizes no
  // channel at all, which is a mistake worth reporting rather than storing.
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseInput(raw: unknown): SlackSetupInput | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { botToken, signingSecret, appUrl, channelMap, allowedUserIds } = raw;
  if (
    typeof botToken !== "string" ||
    botToken.length === 0 ||
    typeof signingSecret !== "string" ||
    signingSecret.length === 0 ||
    typeof appUrl !== "string" ||
    appUrl.length === 0
  ) {
    return undefined;
  }

  const parsedChannelMap = parseChannelMap(channelMap);
  if (!parsedChannelMap) {
    return undefined;
  }

  if (allowedUserIds !== undefined && !isStringArray(allowedUserIds)) {
    return undefined;
  }

  return {
    botToken,
    signingSecret,
    appUrl,
    channelMap: parsedChannelMap,
    ...(allowedUserIds === undefined ? {} : { allowedUserIds }),
  };
}

/** The generic ingress route (Section 6 Task 1), addressed by this plugin's
 * id and its `channels/events.ts` slot name -- see docs/plugins.md. */
function buildWebhookUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/channels/slack/events`;
}

async function execute(
  input: unknown,
  api: PluginApi,
): Promise<SlackSetupResult> {
  const parsed = parseInput(input);
  if (!parsed) {
    return {
      ok: false,
      error:
        "invalid input: botToken, signingSecret, appUrl and a non-empty channelMap are all required",
    };
  }

  const authTest = await slackAuthTest(api, parsed.botToken);
  if (!authTest.ok) {
    return {
      ok: false,
      error: `Slack rejected the bot token: ${authTest.error ?? "unknown error"}`,
    };
  }

  // The workspace binding is not optional configuration: without it,
  // `channels/events.ts` has no way to tell a mention in the operator's
  // workspace from a mention in anyone else's. Nothing is stored if Slack
  // did not name one, so a half-configured installation cannot be left
  // accepting events it should refuse.
  if (!authTest.teamId) {
    return {
      ok: false,
      error:
        "Slack's auth.test did not return a team_id, so this installation cannot be bound to a workspace. Nothing was stored.",
    };
  }

  await Promise.all([
    api.kv.set(KV_BOT_TOKEN, parsed.botToken),
    api.kv.set(KV_SIGNING_SECRET, parsed.signingSecret),
    api.kv.set(KV_TEAM_ID, authTest.teamId),
    api.kv.set(KV_ALLOWED_USERS, parsed.allowedUserIds ?? []),
    ...Object.entries(parsed.channelMap).map(([slackChannelId, sessionId]) =>
      api.kv.set(kvChannelMapKey(slackChannelId), sessionId),
    ),
  ]);

  return {
    ok: true,
    webhookUrl: buildWebhookUrl(parsed.appUrl),
    team: authTest.team,
    teamId: authTest.teamId,
    botUserId: authTest.botUserId,
  };
}

const slackSetupTool: PluginToolModule = {
  name: "slack_setup",
  description:
    "One-time Slack setup: validates the bot token, binds this installation to that token's Slack workspace, stores the signing secret and per-channel session routing, and returns the webhook URL to paste into Slack's Event Subscriptions.",
  inputSchema: {
    type: "object",
    properties: {
      botToken: {
        type: "string",
        description: "Slack bot token (xoxb-...).",
      },
      signingSecret: {
        type: "string",
        description: "Slack app signing secret, from Basic Information.",
      },
      appUrl: {
        type: "string",
        description: "Paco's public origin, e.g. https://paco.example.com.",
      },
      channelMap: {
        type: "object",
        description:
          "Slack channel id -> Paco session id. Required, and at least one entry: a mention only starts work in a channel listed here.",
        additionalProperties: { type: "string" },
      },
      allowedUserIds: {
        type: "array",
        description:
          "Optional Slack user ids allowed to start work. Omit to allow any member of a mapped channel.",
        items: { type: "string" },
      },
    },
    required: ["botToken", "signingSecret", "appUrl", "channelMap"],
    additionalProperties: false,
  },
  execute,
};

export default slackSetupTool;
