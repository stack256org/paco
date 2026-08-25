import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Shared secret between Paco and the standalone plugin MCP server
 * (`scripts/plugin-mcp-server.ts`).
 *
 * That server runs as its own process, spawned by the Claude Code CLI over
 * stdio, so it has no browser session to authenticate with — it carries this
 * token instead, handed to it through its environment
 * (`PACO_INTERNAL_TOKEN`, see `lib/plugins/mcp-bridge.ts`). Without it,
 * anything able to reach the internal plugin-tools route on this machine
 * could invoke a plugin's tools directly.
 *
 * Minted per server process, exactly like `lib/agent/approvals/token.ts`'s
 * approval token, and for the same reason: it never has to survive a
 * restart, because the only processes that hold it — bridge servers this
 * process spawned — do not survive one either.
 *
 * Cached on `globalThis` so a Turbopack rebuild does not mint a second token
 * and orphan every bridge server already running with the first.
 */
const globalForToken = globalThis as typeof globalThis & {
  __pacoPluginToolsToken?: string;
};

export function pluginToolsToken(): string {
  globalForToken.__pacoPluginToolsToken ??=
    randomBytes(32).toString("base64url");
  return globalForToken.__pacoPluginToolsToken;
}
