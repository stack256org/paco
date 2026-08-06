import type { ClaudeResultMessage } from "./types.ts";

/**
 * Whether a run failed only because the session it tried to resume is gone.
 *
 * Claude Code scopes a session to the directory it ran in, so a session id
 * stops resolving the moment a chat's working directory changes — which is
 * exactly what giving every chat its own git worktree did. The CLI reports
 * this by exiting immediately with `error_during_execution` and no output at
 * all, which reaches the product as an assistant message with no content and
 * zero tokens: a turn that silently does nothing.
 *
 * Matched on the message rather than the subtype alone because
 * `error_during_execution` covers genuine failures too, and those must not be
 * retried blindly.
 */
export function isMissingSessionResult(result: ClaudeResultMessage): boolean {
  if (!result.is_error) {
    return false;
  }

  const messages = [...(result.errors ?? []), result.result ?? ""];
  return messages.some((message) =>
    /No conversation found with session ID/i.test(message),
  );
}
