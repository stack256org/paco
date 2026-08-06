import "server-only";

import { randomUUID } from "node:crypto";

/**
 * Approvals the agent is currently blocked on.
 *
 * The `PreToolUse` hook runs as a separate process and blocks the CLI until it
 * answers, so this is the rendezvous between that process and the browser: the
 * hook registers a request and waits, the UI shows it, and the user's decision
 * resolves the wait.
 *
 * In memory rather than in the database, and deliberately. A pending approval
 * is only meaningful while the process that is waiting on it is alive; if the
 * server restarts, that process is gone too, and a row describing a decision
 * nobody is waiting for would be worse than no row.
 *
 * On `globalThis` for the same reason as the database pool: a module-level map
 * does not survive a Turbopack rebuild in development, and losing the map
 * would strand every in-flight request until its timeout.
 */

export type ApprovalRequest = {
  id: string;
  chatId: string;
  toolName: string;
  /** Why the policy stopped this call, in words the user can act on. */
  reason: string;
  /** The command for Bash, or the path for a write. Shown verbatim. */
  detail: string;
  requestedAt: number;
};

export type ApprovalOutcome = "allow" | "deny";

type Pending = {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * How long the agent waits before the request is denied for it.
 *
 * Fails closed. The alternative — allow on timeout — means walking away from
 * the browser silently grants everything the policy stopped, which is the
 * opposite of what this is for. Five minutes is long enough to read a command
 * and short enough that a forgotten tab does not pin a CLI process all day.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const globalForApprovals = globalThis as typeof globalThis & {
  __pacoApprovals?: Map<string, Pending>;
};

function pendingMap(): Map<string, Pending> {
  globalForApprovals.__pacoApprovals ??= new Map();
  return globalForApprovals.__pacoApprovals;
}

/**
 * Register a request and wait for the user.
 *
 * Resolves with `"deny"` on timeout or abort rather than rejecting, so the
 * caller has one shape to handle and the agent always gets an answer.
 */
export function requestApproval(params: {
  chatId: string;
  toolName: string;
  reason: string;
  detail: string;
  signal?: AbortSignal;
}): Promise<ApprovalOutcome> {
  const id = randomUUID();
  const request: ApprovalRequest = {
    id,
    chatId: params.chatId,
    toolName: params.toolName,
    reason: params.reason,
    detail: params.detail,
    requestedAt: Date.now(),
  };

  // `withResolvers` rather than an executor: the same request can be settled
  // by the user, by the timeout, or by an aborted turn, and the settle
  // function has to be reachable from all three.
  const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>();
  let settled = false;

  const settle = (outcome: ApprovalOutcome) => {
    if (settled) {
      return;
    }
    settled = true;

    const entry = pendingMap().get(id);
    if (entry) {
      clearTimeout(entry.timer);
      pendingMap().delete(id);
    }
    resolve(outcome);
  };

  const timer = setTimeout(() => settle("deny"), APPROVAL_TIMEOUT_MS);
  pendingMap().set(id, { request, resolve: settle, timer });

  // A cancelled turn must not leave the hook process waiting for a decision
  // about work that is no longer happening.
  params.signal?.addEventListener("abort", () => settle("deny"), {
    once: true,
  });

  return promise;
}

/** Everything this chat is currently waiting on, oldest first. */
export function listPendingApprovals(chatId: string): ApprovalRequest[] {
  return [...pendingMap().values()]
    .map((entry) => entry.request)
    .filter((request) => request.chatId === chatId)
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

/**
 * Answer a request.
 *
 * Returns false when the id is unknown, which is the normal outcome of a
 * double click or a decision that arrives after the request timed out.
 */
export function resolveApproval(
  id: string,
  chatId: string,
  outcome: ApprovalOutcome,
): boolean {
  const entry = pendingMap().get(id);
  // The chat id is checked as well as the id: the request id alone is a
  // capability, and a user must not be able to answer another chat's prompt.
  if (!entry || entry.request.chatId !== chatId) {
    return false;
  }

  entry.resolve(outcome);
  return true;
}
