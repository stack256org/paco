import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { OpenFxBackend } from "@paco/openfx-backend";

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
 */
export function capabilitiesForBackend(
  backend: string | null | undefined,
): BackendCapabilities {
  if (backend === "openfx") {
    return new OpenFxBackend().capabilities();
  }
  return new ClaudeCodeBackend().capabilities();
}
