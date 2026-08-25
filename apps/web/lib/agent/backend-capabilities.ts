import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { OpenFxBackend } from "@paco/openfx-backend";
import { normalizeBackendId } from "./backend-factory";

/**
 * A chat's `capabilities`, computed from the real backend it runs on.
 *
 * Used wherever a chat crosses from the server to the client (the initial
 * page load in `page.tsx`, and the `PATCH` route a backend switch goes
 * through) so the client never has to guess what a backend id supports —
 * `EffortSelectorCompact`'s host in `session-chat-content.tsx` hides the
 * control when `capabilities.effort` is `false` instead of hardcoding
 * `chatInfo.backend === "openfx"`, which is exactly the coupling capability-
 * driven UI exists to avoid.
 *
 * Instantiating `ClaudeCodeBackend`/`OpenFxBackend` here (rather than
 * hand-copying their `capabilities()` literals into a client-safe map) is
 * what keeps this in sync with the real backends without a second place to
 * update — both constructors are side-effect-free; only `startTurn` spawns
 * anything.
 *
 * The stored id is normalized through `normalizeBackendId` rather than
 * compared directly, so this agrees with `resolveBackend` — the thing that
 * decides which backend actually RUNS the turn — by construction. A
 * hand-written `backend === "openfx" ? … : claude` here happens to match
 * today only because there are exactly two backends: adding a third would
 * silently report Claude Code's capabilities for it while `resolveBackend`
 * warned and fell back, which is the same class of quiet divergence that
 * produced the cross-backend resume-token bug.
 */
export function capabilitiesForBackend(
  backend: string | null | undefined,
): BackendCapabilities {
  if (normalizeBackendId(backend) === "openfx") {
    return new OpenFxBackend().capabilities();
  }
  return new ClaudeCodeBackend().capabilities();
}
