import "server-only";

import type { AgentBackend } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import {
  buildPoolsideBackendConfig,
  PoolsideBackend,
} from "@paco/poolside-backend";
import { readInstanceSettings } from "@/lib/settings/instance-settings";

/**
 * `chats.backend`'s enum, as `apps/web/lib/db/schema.ts` declares it.
 *
 * Not imported from `schema.ts` directly: that type is the raw column type
 * (`string | null` widens once Drizzle infers the row), and this module wants
 * its own narrow, exhaustive set to switch on.
 */
export type ChatBackendId = "claude-code" | "poolside";

/**
 * Every id `chats.backend` may hold, in the order a picker should offer them.
 *
 * Exported because the PATCH route (`app/api/sessions/[sessionId]/chats/
 * [chatId]/route.ts`) has to REJECT an unknown value rather than normalize
 * it, so it cannot call `normalizeBackendId` — and a hand-copied literal
 * there is how a set of ids drifts out of step with the enum it is supposed
 * to mirror. One array, two readers.
 */
export const CHAT_BACKEND_IDS: readonly ChatBackendId[] = [
  "claude-code",
  "poolside",
];

const KNOWN_BACKENDS: ReadonlySet<string> = new Set<ChatBackendId>(
  CHAT_BACKEND_IDS,
);

/** The only field `resolveBackend` reads — the raw `chats.backend` column. */
export interface BackendSelectionInput {
  backend?: string | null;
}

/** Whether a raw column value names a backend this build can run. */
export function isKnownBackendId(value: string): value is ChatBackendId {
  return KNOWN_BACKENDS.has(value);
}

/**
 * The single fallback rule for `chats.backend`: `"claude-code"` for
 * anything that isn't a recognised backend id — `null`/`undefined` (a chat
 * predating the column, or a caller that never fetched it) exactly like an
 * unrecognised non-null string (a stale client, a manual row edit, a chat
 * still holding a retired backend's id, a future enum value this build
 * doesn't know about yet).
 *
 * That retired-id case is live rather than hypothetical: this column held a
 * second backend's id before Poolside replaced it, and migration
 * `0015_poolside_backend.sql` rewrites those rows — but this rule is what
 * makes a row the migration somehow missed run on Claude Code with a
 * warning instead of failing to resolve a backend at all.
 *
 * Exported so every reader of `chat.backend` — `resolveBackend` below,
 * `capabilitiesForBackend` (`backend-capabilities.ts`), and the chat
 * workflow's own `currentBackend` (`app/workflows/chat.ts`, which decides
 * which key a turn's resume token is written under) — normalizes through
 * the exact same rule. Two independently-written fallbacks used to exist
 * here: `resolveBackend` treated an unrecognised *non-null* string as
 * claude-code, while the workflow's `chat?.backend ?? "claude-code"` only
 * caught `null`/`undefined` and would have passed an unrecognised string
 * straight through. A chat somehow holding one would then have run its
 * turn on Claude Code (via `resolveBackend`'s fallback) while writing the
 * result's resume token under that unrecognised string's key instead of
 * `"claude-code"` — the exact class of cross-backend-token bug fixed in
 * "Scope agent resume tokens per backend". The PATCH route already
 * validates against the enum before any write, so this was prevention, not
 * a live bug — but a future write path that skips the route must not be
 * able to reintroduce the divergence by construction.
 */
export function normalizeBackendId(
  value: string | null | undefined,
): ChatBackendId {
  if (value == null) {
    return "claude-code";
  }
  if (isKnownBackendId(value)) {
    return value;
  }
  console.warn(
    `[backend-factory] Unknown chat backend "${value}"; falling back to claude-code.`,
  );
  return "claude-code";
}

/**
 * Resolve the `AgentBackend` a chat's turns should run through.
 *
 * `chat.backend` is `chats.backend` from the database: `"claude-code"` by
 * default, `"poolside"` once a chat opts in. An unrecognised value — a stale
 * client, a manual row edit, a future enum value this build doesn't know
 * about yet — falls back to Claude Code with a warning rather than throwing,
 * so a chat is never simply unable to run a turn because of a bad enum value.
 *
 * Poolside's executable/env come from the instance's own settings (BYO base
 * URL/key/binary path, sealed with `lib/crypto/secret-box` the same way
 * GitHub tokens and the SMTP password are) — read fresh on every call rather
 * than cached, so an operator's edit in Settings takes effect on the very
 * next turn.
 *
 * The settings row is handed straight to the package's own
 * `buildPoolsideBackendConfig` rather than mapped here, so exactly one place
 * decides which env var carries which field. That mapping is the substantive
 * improvement over the provider config this replaces, which stored an
 * `endpoint` and then forwarded it nowhere — no flag or environment variable
 * existed to redirect that binary's provider traffic — so an operator could
 * type a URL into Settings, see it saved, and have it change nothing.
 * `baseUrl` becomes `POOLSIDE_STANDALONE_BASE_URL`, which the package
 * verified against the real binary: it flips the handshake's
 * `poolside/service_mode` to the given host, so it genuinely selects the
 * deployment.
 */
export async function resolveBackend(
  chat: BackendSelectionInput,
): Promise<AgentBackend> {
  const requested = normalizeBackendId(chat.backend);

  if (requested === "poolside") {
    const settings = await readInstanceSettings();
    return new PoolsideBackend(buildPoolsideBackendConfig(settings.poolside));
  }

  return new ClaudeCodeBackend();
}
