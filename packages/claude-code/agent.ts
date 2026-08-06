import type { UIMessageChunk } from "ai";
import type { ClaudeCodeOptions } from "./options.ts";
import { isMissingSessionResult } from "./resume.ts";
import { runClaudeCode } from "./run.ts";
import {
  type ClaudeMessage,
  type ClaudeResultMessage,
  isResultMessage,
} from "./types.ts";
import { ClaudeUIStreamMapper } from "./ui-stream.ts";

/** Token/cost accounting for one Claude Code turn. */
export interface ClaudeRunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd?: number;
  /** Per-model breakdown, keyed by full model id. */
  models: Record<string, { inputTokens: number; outputTokens: number }>;
}

export interface ClaudeAgentStream {
  /** UI chunks ready to write to the client stream. */
  chunks: AsyncIterable<UIMessageChunk>;
  /** Resolves with the terminal result once the stream is fully consumed. */
  result: Promise<ClaudeResultMessage>;
  /** Resolves once the session is established. */
  sessionId: Promise<string>;
}

/**
 * Run one Claude Code turn and expose it as a UI chunk stream.
 *
 * `result` only settles after `chunks` has been consumed to completion: the
 * terminal message is the last thing the CLI writes, so draining the stream is
 * what makes it available.
 *
 * A resume that names a session the CLI no longer has is retried once without
 * it. Claude Code scopes a session to the directory it ran in, so a stored
 * session id stops resolving whenever a chat's working directory moves — as it
 * did when every chat gained its own git worktree. Left alone the CLI exits
 * immediately having written nothing, and the turn reaches the user as an
 * empty assistant message with zero tokens. Starting fresh loses the CLI's own
 * history for that chat, but the conversation itself is stored by Paco and is
 * replayed into the prompt, so the turn still runs with its context.
 */
export function streamClaudeAgent(
  prompt: string,
  options: ClaudeCodeOptions,
  signal?: AbortSignal,
): ClaudeAgentStream {
  const resultDeferred = Promise.withResolvers<ClaudeResultMessage>();
  const sessionDeferred = Promise.withResolvers<string>();

  async function* chunks(): AsyncGenerator<UIMessageChunk> {
    let run = runClaudeCode(prompt, options, signal);
    let iterator = run.messages[Symbol.asyncIterator]();

    // A failed resume is recognisable from the very first message: the CLI
    // writes its `system/init` preamble when it starts normally, and nothing
    // but the terminal `result` when the session id does not resolve. Peeking
    // one message is therefore enough to decide, and the rest of the turn
    // still streams live — buffering it all would trade a silent failure for
    // a UI that shows nothing until the turn ends.
    let first = await iterator.next();

    if (
      options.resume !== undefined &&
      !first.done &&
      isResultMessage(first.value) &&
      isMissingSessionResult(first.value)
    ) {
      const { resume: _dropped, ...withoutResume } = options;
      run = runClaudeCode(prompt, withoutResume, signal);
      iterator = run.messages[Symbol.asyncIterator]();
      first = await iterator.next();
    }

    // Forwarded rather than returned directly because which run settles them
    // is only known after the resume check above.
    run.result.then(resultDeferred.resolve).catch(resultDeferred.reject);
    run.sessionId.then(sessionDeferred.resolve).catch(sessionDeferred.reject);

    const mapper = new ClaudeUIStreamMapper({ workspaceRoot: options.cwd });
    for (let step = first; !step.done; step = await iterator.next()) {
      for (const chunk of mapper.map(step.value)) {
        yield chunk;
      }
    }
  }

  return {
    chunks: chunks(),
    result: resultDeferred.promise,
    sessionId: sessionDeferred.promise,
  };
}

/** Normalize the CLI's terminal result into a usage summary. */
export function toRunUsage(result: ClaudeResultMessage): ClaudeRunUsage {
  const usage = result.usage;
  const models: ClaudeRunUsage["models"] = {};

  for (const [model, entry] of Object.entries(result.modelUsage ?? {})) {
    models[model] = {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    };
  }

  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    totalCostUsd: result.total_cost_usd,
    models,
  };
}

/**
 * Map the CLI's terminal state onto an AI SDK finish reason.
 *
 * `error_max_turns` is reported as `length` because that is how the UI already
 * renders a run that was cut short rather than one that failed.
 */
export function toFinishReason(
  result: ClaudeResultMessage,
): "stop" | "length" | "error" | "tool-calls" {
  if (result.subtype === "error_max_turns") {
    return "length";
  }
  if (result.is_error) {
    return "error";
  }
  if (result.stop_reason === "tool_use") {
    return "tool-calls";
  }
  return "stop";
}

/** Collect every protocol message, for diagnostics and tests. */
export async function collectMessages(
  messages: AsyncIterable<ClaudeMessage>,
): Promise<ClaudeMessage[]> {
  const collected: ClaudeMessage[] = [];
  for await (const message of messages) {
    collected.push(message);
  }
  return collected;
}
