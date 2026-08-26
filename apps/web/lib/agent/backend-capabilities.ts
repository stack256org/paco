import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { PoolsideBackend } from "@paco/poolside-backend";
import { CLAUDE_MODEL_IDS } from "@/lib/model-catalog";
import { normalizeBackendId } from "./backend-factory";

/**
 * A chat's `capabilities`, computed from the real backend it runs on.
 *
 * Used wherever a chat crosses from the server to the client (the initial
 * page load in `page.tsx`, the `PATCH` route a backend switch goes through,
 * and the settings page's Poolside section) so the client never has to guess
 * what a backend id supports — `EffortSelectorCompact`'s host in
 * `session-chat-content.tsx` hides the control when `capabilities.effort` is
 * `false` instead of hardcoding `chatInfo.backend === "poolside"`, which is
 * exactly the coupling capability-driven UI exists to avoid.
 *
 * Instantiating `ClaudeCodeBackend`/`PoolsideBackend` here (rather than
 * hand-copying their `capabilities()` literals into a client-safe map) is
 * what keeps this in sync with the real backends without a second place to
 * update — both constructors are side-effect-free; only `startTurn` spawns
 * anything. `PoolsideBackend` is constructed with no config on purpose: the
 * instance's stored binary path and credentials decide how a turn RUNS, not
 * what the protocol can carry, so they cannot change the answer here and
 * reading them would make this async for nothing.
 *
 * The stored id is normalized through `normalizeBackendId` rather than
 * compared directly, so this agrees with `resolveBackend` — the thing that
 * decides which backend actually RUNS the turn — by construction. A
 * hand-written `backend === "poolside" ? … : claude` here happens to match
 * today only because there are exactly two backends: adding a third would
 * silently report Claude Code's capabilities for it while `resolveBackend`
 * warned and fell back, which is the same class of quiet divergence that
 * produced the cross-backend resume-token bug. It also matters for a chat
 * row still holding the id of the retired second backend: both this and
 * `resolveBackend` answer claude-code for it, rather than one of them
 * reporting capabilities for a backend that no longer exists.
 */
export function capabilitiesForBackend(
  backend: string | null | undefined,
): BackendCapabilities {
  const capabilities =
    normalizeBackendId(backend) === "poolside"
      ? new PoolsideBackend().capabilities()
      : new ClaudeCodeBackend().capabilities();
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
 * every option you were given". That was harmless while every option was a
 * Claude alias; now that the options span vendors it would offer a Poolside
 * model to a Claude Code chat, which the CLI rejects.
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
