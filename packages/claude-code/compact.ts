import { runClaudeCode } from "./run.ts";
import type { ClaudeCodeOptions } from "./options.ts";

/**
 * Compact a chat's Claude Code session.
 *
 * The CLI owns the conversation history — Paco replays nothing — so shrinking
 * it has to be asked of the CLI, and `/compact` is the only way in. That is a
 * built-in slash command, which normal turns disable, so this runs as its own
 * invocation with slash commands allowed rather than loosening every turn.
 *
 * The CLI reports progress as `system`/`status` messages: `status: "compacting"`
 * while it works, then a `compact_result` with a `compact_error` when it could
 * not. It is not an error for compaction to decline — "Not enough messages to
 * compact" is the normal answer on a short conversation — so that comes back as
 * a reason rather than a throw.
 */

export type CompactOutcome =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

type StatusMessage = {
  type?: string;
  subtype?: string;
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
  result?: string;
  is_error?: boolean;
};

export async function compactSession(params: {
  /** Claude Code session id to compact. */
  sessionId: string;
  /** The chat's worktree — a session only resolves from its own directory. */
  cwd: string;
  signal?: AbortSignal;
}): Promise<CompactOutcome> {
  const options: ClaudeCodeOptions = {
    cwd: params.cwd,
    resume: params.sessionId,
    permissionMode: "bypassPermissions",
    allowSlashCommands: true,
  };

  const run = runClaudeCode("/compact", options, params.signal);

  let compactError: string | undefined;
  let sawCompacting = false;

  for await (const message of run.messages) {
    const status = message as StatusMessage;
    if (status.type !== "system" || status.subtype !== "status") {
      continue;
    }

    if (status.status === "compacting") {
      sawCompacting = true;
    }
    if (status.compact_error) {
      compactError = status.compact_error;
    }
  }

  const result = (await run.result) as StatusMessage;
  const text = typeof result.result === "string" ? result.result.trim() : "";

  if (compactError) {
    return { ok: false, reason: compactError };
  }

  // No "compacting" status at all means the command never ran — the usual
  // cause is slash commands being unavailable, which answers with prose rather
  // than an error and would otherwise read as a silent success.
  if (!sawCompacting) {
    return {
      ok: false,
      reason: text || "The CLI did not run the compact command.",
    };
  }

  if (result.is_error) {
    return { ok: false, reason: text || "Compaction failed." };
  }

  return { ok: true, summary: text };
}
