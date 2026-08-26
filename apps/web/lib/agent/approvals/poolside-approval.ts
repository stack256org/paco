import "server-only";

import type {
  PermissionDecision,
  PermissionHandler,
  PermissionRequestParams,
} from "@paco/poolside-backend";
import { requestApproval } from "./store";

/**
 * ACP tool-call kinds that never write or run anything (ACP's
 * `tool_call.kind` enum: `read,edit,delete,move,search,execute,think,fetch,
 * other`). Mapped onto `decideApproval`'s own always-allow set so a read,
 * search, or "thinking" tool call doesn't stop a turn for a decision Claude
 * Code's own policy would never ask about either.
 */
const READ_ONLY_KINDS = new Set(["read", "search", "think"]);

/** ACP kinds that write, move, or delete something. */
const WRITE_KINDS = new Set(["edit", "move", "delete"]);

/**
 * Map an ACP `toolCall.kind` onto the tool name `decideApproval` (Claude
 * Code's own policy — `packages/claude-code/approval-policy.ts`) knows how to
 * judge, so both backends' permission requests are decided by the exact same
 * rules.
 *
 * `rawInput`'s shape is agent-specific and not part of the ACP schema, so
 * this is deliberately conservative: a kind this function cannot confidently
 * place lands on `"Other"`, which `decideApproval` treats as "a tool it does
 * not recognise" and always asks about — safe, per the same fails-closed
 * rule `decideApproval` itself documents, rather than guessing allow.
 *
 * The kind is all this can rely on, but not all it GETS: Poolside does
 * populate `rawInput` on the wire, so `decideApproval`'s path-based branches
 * below (and the `detail` string the approval card shows the user) have real
 * arguments to work with rather than the empty object the previous ACP
 * backend left them.
 */
function toolNameForKind(kind: string): string {
  if (READ_ONLY_KINDS.has(kind)) {
    return "Read";
  }
  if (kind === "fetch") {
    // Network access, not a worktree write — closer to `WebFetch`
    // (read-only) than to a write tool.
    return "WebFetch";
  }
  if (WRITE_KINDS.has(kind)) {
    // `decideApproval`'s `WRITE_TOOLS` branch inspects `call.input` for a
    // path under one of a handful of key names (`file_path`, `path`, ...).
    // If Poolside's `rawInput` doesn't use one of those keys, the lookup
    // fails closed to "ask" rather than allow — see `writeTarget`'s own doc
    // in `approval-policy.ts`.
    return "Edit";
  }
  if (kind === "execute") {
    return "Bash";
  }
  // "other", and anything future ACP adds that isn't in the enum above.
  return "Other";
}

function toInputRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

type PermissionOption = PermissionRequestParams["options"][number];

/** First option in `preferredIds` order that the server actually offered. */
function pickOptionId(
  options: PermissionOption[],
  preferredIds: string[],
): string | undefined {
  for (const id of preferredIds) {
    const match = options.find((option) => option.optionId === id);
    if (match) {
      return match.optionId;
    }
  }
  return options[0]?.optionId;
}

/**
 * ACP's permission option ids: `allow_once`, `allow_always`, `reject_once`,
 * `reject_always`. Preferring the "once" variant over "always" mirrors
 * `decideApproval` itself, which is re-evaluated on every call rather than
 * remembered — an "always" answer would hand the decision to Poolside's own
 * session state, where Paco's policy could no longer see it.
 */
function selectDecision(
  options: PermissionOption[],
  preferredIds: string[],
): PermissionDecision {
  const optionId = pickOptionId(options, preferredIds);
  if (!optionId) {
    // The agent offered nothing usable — ACP treats a missing selection the
    // same as an explicit cancel/deny.
    return { outcome: { outcome: "cancelled" } };
  }
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * Build the `PoolsideBackendOptions.onApprovalRequest` handler for one turn.
 *
 * Routes ACP's `session/request_permission` (a JSON-RPC request already
 * delivered over the connection this backend owns) through the exact same
 * seam the Claude Code `PreToolUse` hook uses: `decideApproval` decides, and
 * anything it doesn't auto-allow goes to `requestApproval` — the same
 * in-memory rendezvous `POST /api/internal/approvals` answers for Claude's
 * hook subprocess (`lib/agent/approvals/store.ts`), which is what makes the
 * approval-request UI backend-agnostic: it has never known which backend is
 * asking, only a chat id, a reason, and a detail string.
 *
 * There is no HTTP round trip here, unlike Claude's hook: Poolside's ACP
 * connection already lives in this same process, so this handler calls
 * `decideApproval`/`requestApproval` directly instead of reproducing
 * `approval.ts`'s spawned-subprocess mechanism.
 *
 * This is also why `run-step.ts` leaves Poolside's session in its `default`
 * permission mode rather than `always-allow`: the whole gate is this
 * handler, and a session that stopped sending `session/request_permission`
 * would silently take Paco's policy out of the loop.
 */
export function createPoolsideApprovalHandler(params: {
  chatId: string;
  worktree: string;
}): PermissionHandler {
  return async (
    request: PermissionRequestParams,
  ): Promise<PermissionDecision> => {
    // Imported lazily rather than at module scope: this module is pulled in
    // by `run-step.ts` on every turn regardless of which backend a chat
    // uses, and `@paco/claude-code` is a real dependency (a process
    // spawner, an approval-hook file writer) that a Claude Code turn's own
    // tests already stub out wholesale — a static import here would force
    // every one of those stubs to also describe `decideApproval`, for a
    // function they never call.
    const { decideApproval } = await import("@paco/claude-code");
    const toolName = toolNameForKind(request.toolCall.kind);
    const decision = decideApproval(
      { name: toolName, input: toInputRecord(request.toolCall.rawInput) },
      params.worktree,
    );

    if (decision.kind === "allow") {
      return selectDecision(request.options, ["allow_once", "allow_always"]);
    }

    const outcome = await requestApproval({
      chatId: params.chatId,
      toolName: request.toolCall.title || toolName,
      reason: decision.reason,
      detail: JSON.stringify(request.toolCall.rawInput ?? {}).slice(0, 400),
    });

    return outcome === "allow"
      ? selectDecision(request.options, ["allow_once", "allow_always"])
      : selectDecision(request.options, ["reject_once", "reject_always"]);
  };
}
