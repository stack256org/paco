import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { CLAUDE_MODEL_IDS } from "@/lib/model-catalog";
import { normalizeBackendId } from "./backend-factory";

/**
 * A chat's `capabilities`, computed from the real backend it runs on.
 *
 * Used wherever a chat crosses from the server to the client (the initial
 * page load in `page.tsx` and the `PATCH` route a backend switch goes
 * through) so the client never has to guess what a backend id supports —
 * `EffortSelectorCompact`'s host in `session-chat-content.tsx` hides the
 * control when `capabilities.effort` is `false` instead of hardcoding a
 * backend check, which is exactly the coupling capability-driven UI exists
 * to avoid.
 *
 * Instantiating `ClaudeCodeBackend` here (rather than hand-copying its
 * `capabilities()` literal into a client-safe map) is what keeps this in
 * sync with the real backend without a second place to update — the
 * constructor is side-effect-free; only `startTurn` spawns anything.
 *
 * The stored id is normalized through `normalizeBackendId` rather than
 * compared directly, so this agrees with `resolveBackend` — the thing that
 * decides which backend actually RUNS the turn — by construction. It also
 * matters for a chat row still holding the id of a retired backend: both
 * this and `resolveBackend` answer claude-code for it, rather than one of
 * them reporting capabilities for a backend that no longer exists.
 */
export function capabilitiesForBackend(
  backend: string | null | undefined,
): BackendCapabilities {
  normalizeBackendId(backend);
  const capabilities = new ClaudeCodeBackend().capabilities();
  return withResolvedModels(capabilities);
}

/**
 * Expand `models: undefined` into the actual list before this object leaves
 * the server.
 *
 * `BackendCapabilities.models` defines `undefined` as "the app's own catalog
 * applies unchanged" — a shorthand written when the app's catalog was Claude
 * Code's tier aliases and nothing else. The composer re-applies the same
 * filter client-side, because its backend selector can switch a chat after
 * the page was rendered, and there `undefined` can only be read as "show
 * every option you were given".
 *
 * Resolving the shorthand here rather than teaching the client a second copy
 * of the catalog keeps one list and one rule: the client only ever sees an
 * explicit set of accepted ids. Server-side callers that want the backend's
 * literal declaration still read `backend.capabilities()` directly —
 * `run-step.ts`'s `resolveModelId` does, and `undefined` correctly means
 * "forward whatever the picker chose" there, since Claude Code resolves tier
 * aliases itself.
 */
function withResolvedModels(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  if (capabilities.models !== undefined) {
    return capabilities;
  }
  return { ...capabilities, models: CLAUDE_MODEL_IDS };
}
