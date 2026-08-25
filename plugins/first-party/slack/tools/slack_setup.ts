import type { PluginApi, PluginToolModule } from "@paco/plugin-host";
import { isRecord } from "../lib/guards.ts";
import {
  KV_BOT_TOKEN,
  KV_DEFAULT_SESSION,
  KV_SIGNING_SECRET,
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
  defaultSessionId: string;
  appUrl: string;
  channelMap?: Record<string, string>;
}

export interface SlackSetupResult {
  ok: boolean;
  webhookUrl?: string;
  team?: string;
  botUserId?: string;
  error?: string;
}

function parseInput(raw: unknown): SlackSetupInput | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { botToken, signingSecret, defaultSessionId, appUrl, channelMap } = raw;
  if (
    typeof botToken !== "string" ||
    botToken.length === 0 ||
    typeof signingSecret !== "string" ||
    signingSecret.length === 0 ||
    typeof defaultSessionId !== "string" ||
    defaultSessionId.length === 0 ||
    typeof appUrl !== "string" ||
    appUrl.length === 0
  ) {
    return undefined;
  }

  if (channelMap === undefined) {
    return { botToken, signingSecret, defaultSessionId, appUrl };
  }
  if (!isRecord(channelMap)) {
    return undefined;
  }

  const normalizedChannelMap: Record<string, string> = {};
  for (const [slackChannelId, sessionId] of Object.entries(channelMap)) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return undefined;
    }
    normalizedChannelMap[slackChannelId] = sessionId;
  }
  return {
    botToken,
    signingSecret,
    defaultSessionId,
    appUrl,
    channelMap: normalizedChannelMap,
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
        "invalid input: botToken, signingSecret, defaultSessionId and appUrl are all required",
    };
  }

  const authTest = await slackAuthTest(api, parsed.botToken);
  if (!authTest.ok) {
    return {
      ok: false,
      error: `Slack rejected the bot token: ${authTest.error ?? "unknown error"}`,
    };
  }

  await Promise.all([
    api.kv.set(KV_BOT_TOKEN, parsed.botToken),
    api.kv.set(KV_SIGNING_SECRET, parsed.signingSecret),
    api.kv.set(KV_DEFAULT_SESSION, parsed.defaultSessionId),
    ...Object.entries(parsed.channelMap ?? {}).map(
      ([slackChannelId, sessionId]) =>
        api.kv.set(kvChannelMapKey(slackChannelId), sessionId),
    ),
  ]);

  return {
    ok: true,
    webhookUrl: buildWebhookUrl(parsed.appUrl),
    team: authTest.team,
    botUserId: authTest.botUserId,
  };
}

const slackSetupTool: PluginToolModule = {
  name: "slack_setup",
  description:
    "One-time Slack setup: validates the bot token, stores the signing secret and session routing, and returns the webhook URL to paste into Slack's Event Subscriptions.",
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
      defaultSessionId: {
        type: "string",
        description: "Paco session used for channels with no explicit mapping.",
      },
      appUrl: {
        type: "string",
        description: "Paco's public origin, e.g. https://paco.example.com.",
      },
      channelMap: {
        type: "object",
        description: "Optional Slack channel id -> Paco session id overrides.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["botToken", "signingSecret", "defaultSessionId", "appUrl"],
    additionalProperties: false,
  },
  execute,
};

export default slackSetupTool;
