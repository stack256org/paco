import type { PluginApi } from "@paco/plugin-host";
import { isRecord } from "./guards.ts";
import { KV_BOT_TOKEN } from "./kv-keys.ts";

/** Slack's Web API host. Every call this plugin makes goes through it --
 * kept as the single source `plugin.json`'s `netDomains` is verified
 * against. */
const SLACK_API_BASE = "https://slack.com/api";

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  team?: string;
  /** The workspace id (`auth.test`'s `team_id`). `channels/events.ts` binds
   * to it so a signature-valid event from another workspace is refused. */
  teamId?: string;
  botUserId?: string;
}

function parseSlackApiResponse(body: string): SlackApiResponse {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.ok === "boolean") {
      return {
        ok: parsed.ok,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
        ts: typeof parsed.ts === "string" ? parsed.ts : undefined,
        team: typeof parsed.team === "string" ? parsed.team : undefined,
        teamId: typeof parsed.team_id === "string" ? parsed.team_id : undefined,
        botUserId:
          typeof parsed.user_id === "string" ? parsed.user_id : undefined,
      };
    }
  } catch {
    // Falls through to the generic failure below.
  }
  return { ok: false, error: "unparsable Slack response" };
}

/** Calls `auth.test`, to validate a bot token during `tools/slack-setup.ts`. */
export async function slackAuthTest(
  api: PluginApi,
  botToken: string,
): Promise<SlackApiResponse> {
  const response = await api.fetch({
    url: `${SLACK_API_BASE}/auth.test`,
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}` },
  });
  return parseSlackApiResponse(response.body);
}

/**
 * Posts a threaded message via `chat.postMessage`, reading the bot token
 * from kv (set once by `tools/slack-setup.ts`). Never throws: a missing
 * token or a Slack-side failure is logged through `api.log` and returned as
 * `{ok: false}` rather than breaking the ingress request or hook delivery
 * that triggered it.
 */
export async function postThreadMessage(
  api: PluginApi,
  channel: string,
  threadTs: string,
  text: string,
): Promise<SlackApiResponse> {
  const botToken = await api.kv.get(KV_BOT_TOKEN);
  if (typeof botToken !== "string" || botToken.length === 0) {
    api.log("error", "slack: no bot token configured; cannot post");
    return { ok: false, error: "no bot token configured" };
  }

  const response = await api.fetch({
    url: `${SLACK_API_BASE}/chat.postMessage`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });

  const parsed = parseSlackApiResponse(response.body);
  if (!parsed.ok) {
    api.log(
      "error",
      `slack: chat.postMessage failed: ${parsed.error ?? "unknown error"}`,
    );
  }
  return parsed;
}
