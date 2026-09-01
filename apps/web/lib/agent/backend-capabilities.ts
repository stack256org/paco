import "server-only";

import type { BackendCapabilities } from "@paco/agent-backend";
import { ClaudeCodeBackend } from "@paco/claude-code";
import { CLAUDE_MODEL_IDS, listClaudeModels } from "@/lib/model-catalog";
import { readInstanceSettings } from "@/lib/settings/instance-settings";
import { normalizeBackendId } from "./backend-factory";

/**
 * A chat's `capabilities`, computed from the real backend it runs on.
 *
 * Used wherever a chat crosses from the server to the client — the initial
 * page load in `page.tsx`, and the chat `PATCH` route
 * (`app/api/sessions/[sessionId]/chats/[chatId]/route.ts`), which recomputes
 * it on every response so a title/model/effort update also refreshes what a
 * stale client believes the chat supports — so the client never has to guess
 * what a backend id supports. `EffortSelectorCompact`'s host in
 * `session-chat-content.tsx` hides the control when `capabilities.effort` is
 * `false` instead of hardcoding a backend check, which is exactly the
 * coupling capability-driven UI exists to avoid.
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
export async function capabilitiesForBackend(
  backend: string | null | undefined,
): Promise<BackendCapabilities> {
  // Kept only for the console.warn side effect on a retired backend id; the
  // resolved value itself is discarded — capabilities always come from
  // ClaudeCodeBackend.
  normalizeBackendId(backend);
  const capabilities = new ClaudeCodeBackend().capabilities();
  return await withResolvedModels(capabilities);
}

/**
 * Expand `models: undefined` into the actual list before this object leaves
 * the server.
 *
 * `BackendCapabilities.models` defines `undefined` as "the app's own catalog
 * applies unchanged" — a shorthand written when the app's catalog was Claude
 * Code's tier aliases and nothing else. `model-catalog.ts`, which resolves
 * that shorthand, is `server-only` and cannot be imported into the client
 * component that renders the model picker
 * (`model-effort-backend-controls.tsx`), so the client has no way to
 * interpret `undefined` itself — it can only filter `modelOptions` against
 * an explicit `capabilities.models` list. That component's own comment says
 * as much: "`undefined` DOES NOT mean 'show everything'". This function is
 * what makes that true by construction, by never letting `undefined` reach
 * the client in the first place.
 *
 * Resolving the shorthand here rather than teaching the client a second copy
 * of the catalog keeps one list and one rule: the client only ever sees an
 * explicit set of accepted ids. Server-side callers that want the backend's
 * literal declaration still read `backend.capabilities()` directly —
 * `run-step.ts`'s `resolveModelId` does, and `undefined` correctly means
 * "forward whatever the picker chose" there, since Claude Code resolves tier
 * aliases itself.
 *
 * The list itself comes from `listClaudeModels(claudeBaseUrl)`, not the
 * static `CLAUDE_MODEL_IDS` — with a gateway configured and discovered,
 * that is the gateway's own ids, and this is the set the composer
 * (`model-effort-backend-controls.tsx`) filters `modelOptions` against
 * before deciding whether to render the picker at all. Resolving it against
 * the static aliases unconditionally is what made the picker vanish for a
 * configured gateway: `modelOptions` (built from `listClaudeModels`
 * elsewhere, e.g. `getInitialModels` in `page.tsx`) held gateway ids, none
 * of which matched the static aliases this used to fall back to, so every
 * option was filtered out. `readInstanceSettings` failing (or reporting no
 * gateway) falls back to `CLAUDE_MODEL_IDS`, same as `listClaudeModels`
 * itself falls back to the static catalog for an absent or unreadable
 * discovery cache — an operator must never be left with an empty picker.
 */
async function withResolvedModels(
  capabilities: BackendCapabilities,
): Promise<BackendCapabilities> {
  if (capabilities.models !== undefined) {
    return capabilities;
  }
  let claudeBaseUrl: string | null = null;
  try {
    ({ claudeBaseUrl } = await readInstanceSettings());
  } catch (error) {
    console.error(
      "[backend-capabilities] Could not read instance settings; falling back to the static model catalog:",
      error,
    );
  }
  const models = listClaudeModels(claudeBaseUrl).map((model) => model.id);
  return {
    ...capabilities,
    models: models.length > 0 ? models : CLAUDE_MODEL_IDS,
  };
}
