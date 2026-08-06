import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Shared secret between Paco and the tool-approval hook.
 *
 * The hook runs inside the Claude Code process, so it has no browser session
 * to authenticate with. It carries this token instead, handed to the CLI
 * through its environment.
 *
 * Minted per server process rather than configured: it never has to survive a
 * restart, because the only processes that hold it — the CLI runs this server
 * spawned — do not survive one either. A value that lives exactly as long as
 * the thing it protects cannot leak from a config file or an env dump.
 *
 * Cached on `globalThis` so a Turbopack rebuild does not mint a second token
 * and orphan every agent already running with the first.
 */
const globalForToken = globalThis as typeof globalThis & {
  __pacoApprovalToken?: string;
};

export function approvalToken(): string {
  globalForToken.__pacoApprovalToken ??= randomBytes(32).toString("base64url");
  return globalForToken.__pacoApprovalToken;
}
