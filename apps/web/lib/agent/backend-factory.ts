import "server-only";

import type { AgentBackend } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { OpenFxBackend, type OpenFxBackendConfig } from "@paco/openfx-backend";
import {
  readInstanceSettings,
  type StoredOpenFxSettings,
} from "@/lib/settings/instance-settings";

/**
 * `chats.backend`'s enum, as `apps/web/lib/db/schema.ts` declares it.
 *
 * Not imported from `schema.ts` directly: that type is the raw column type
 * (`string | null` widens once Drizzle infers the row), and this module wants
 * its own narrow, exhaustive set to switch on.
 */
export type ChatBackendId = "claude-code" | "openfx";

const KNOWN_BACKENDS: ReadonlySet<string> = new Set<ChatBackendId>([
  "claude-code",
  "openfx",
]);

/** The only field `resolveBackend` reads — the raw `chats.backend` column. */
export interface BackendSelectionInput {
  backend?: string | null;
}

function isKnownBackend(value: string): value is ChatBackendId {
  return KNOWN_BACKENDS.has(value);
}

/**
 * Map stored OpenFX provider settings onto `OpenFxBackendConfig`.
 *
 * A pure function on purpose, split out of `resolveBackend` so it is testable
 * without a database: given a settings row, does it produce the executable
 * path and env vars `OpenFxBackend`/`AcpClient` actually need?
 *
 * `endpoint` is accepted (BYO provider settings per the plan) but not
 * forwarded to any env var: PROTOCOL.md §1 (Section 7 Task 1's research into
 * the checked-out OpenFX source) found no flag or environment variable that
 * overrides where the `openfx` binary sends provider traffic — only
 * credential vars (`AI_GATEWAY_API_KEY`, `VERCEL_OIDC_TOKEN`). It is stored
 * and shown in settings for forward-compatibility rather than invented here.
 */
export function buildOpenFxBackendConfig(
  settings: StoredOpenFxSettings,
): OpenFxBackendConfig {
  const env: Record<string, string> = {};
  if (settings.apiKey) {
    // PROTOCOL.md §1: the credential env var `loadEnvCredential` reads for
    // the Vercel AI Gateway provider.
    env.AI_GATEWAY_API_KEY = settings.apiKey;
  }

  return {
    ...(settings.binaryPath ? { executable: settings.binaryPath } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * Resolve the `AgentBackend` a chat's turns should run through.
 *
 * `chat.backend` is `chats.backend` from the database: `"claude-code"` by
 * default, `"openfx"` once a chat opts in. An unrecognised value — a stale
 * client, a manual row edit, a future enum value this build doesn't know
 * about yet — falls back to Claude Code with a warning rather than throwing,
 * so a chat is never simply unable to run a turn because of a bad enum value.
 *
 * OpenFX's executable/env come from the instance's own settings (Section 7
 * Task 5: BYO endpoint/key/binary path, sealed with `lib/crypto/secret-box`
 * the same way GitHub tokens and the SMTP password are) — read fresh on every
 * call rather than cached, so an operator's edit in Settings takes effect on
 * the very next turn.
 */
export async function resolveBackend(
  chat: BackendSelectionInput,
): Promise<AgentBackend> {
  const requested = chat.backend ?? "claude-code";

  if (!isKnownBackend(requested)) {
    console.warn(
      `[backend-factory] Unknown chat backend "${requested}"; falling back to claude-code.`,
    );
    return new ClaudeCodeBackend();
  }

  if (requested === "openfx") {
    const settings = await readInstanceSettings();
    return new OpenFxBackend(buildOpenFxBackendConfig(settings.openfx));
  }

  return new ClaudeCodeBackend();
}
