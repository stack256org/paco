import "server-only";

import type { AgentBackend } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";

/**
 * The backends a chat can run on.
 *
 * One member today. The union — and the `@paco/agent-backend` interface it
 * selects — are kept deliberately: they are what `fake-backend.ts` and
 * `conformance.ts` test against, and what a future second backend would slot
 * into. A single-member union costs nothing and states the seam is real.
 */
export type ChatBackendId = "claude-code";

/**
 * Every id `chats.backend` may hold, in the order a picker should offer them.
 *
 * Exported because the PATCH route (`app/api/sessions/[sessionId]/chats/
 * [chatId]/route.ts`) has to REJECT an unknown value rather than normalize
 * it, so it cannot call `normalizeBackendId` — and a hand-copied literal
 * there is how a set of ids drifts out of step with the enum it is supposed
 * to mirror. One array, two readers.
 */
export const CHAT_BACKEND_IDS: readonly ChatBackendId[] = ["claude-code"];

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
 * second backend's id before it was removed — but this rule is what makes a
 * row that somehow still holds it run on Claude Code with a warning instead
 * of failing to resolve a backend at all.
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
 * `chat.backend` is `chats.backend` from the database: `"claude-code"` is
 * the only value this build recognises. An unrecognised value — a stale
 * client, a manual row edit, a future enum value this build doesn't know
 * about yet — falls back to Claude Code with a warning rather than throwing,
 * so a chat is never simply unable to run a turn because of a bad enum value.
 */
export async function resolveBackend(
  chat: BackendSelectionInput,
): Promise<AgentBackend> {
  // Kept only for the console.warn side effect on a retired backend id; the
  // resolved value itself is discarded — every chat runs on ClaudeCodeBackend.
  normalizeBackendId(chat.backend);

  return new ClaudeCodeBackend();
}
