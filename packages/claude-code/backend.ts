import {
  type AgentBackend,
  type BackendCapabilities,
  type TurnContext,
  type TurnHandle,
  type TurnResult,
  zeroUsage,
} from "@paco/agent-backend";
import type { UIMessageChunk } from "ai";
import { streamClaudeAgent, toFinishReason, toRunUsage } from "./agent.ts";
import type { ClaudeCodeOptions } from "./options.ts";

/** Per-turn options for the Claude Code backend, minus the neutral fields. */
export type ClaudeBackendOptions = Omit<ClaudeCodeOptions, "cwd" | "resume">;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Claude Code turn was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * AgentBackend implementation over the Claude Code CLI.
 *
 * Steering is "restart": steer() SIGTERMs the run and reports the turn as
 * cleanly steered; the caller starts the next turn with the steer text and
 * the returned resumeToken, which is how the CLI's own history carries over.
 */
export class ClaudeCodeBackend implements AgentBackend {
  capabilities(): BackendCapabilities {
    return {
      id: "claude-code",
      resume: true,
      steering: "restart",
      mcp: false,
      effort: true,
      subagents: true,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    const backendOptions = (ctx.backendOptions ?? {}) as ClaudeBackendOptions;
    const controller = new AbortController();

    const onOuterAbort = () => controller.abort();
    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        controller.abort();
      } else {
        ctx.abortSignal.addEventListener("abort", onOuterAbort, {
          once: true,
        });
      }
    }

    let steerText: string | undefined;
    let latestSessionId: string | undefined;

    function buildSteeredResult(text: string): TurnResult {
      return {
        finishReason: "stop",
        isError: false,
        usage: zeroUsage(),
        ...(latestSessionId ? { resumeToken: latestSessionId } : {}),
        steered: { text },
      };
    }

    const options: ClaudeCodeOptions = {
      ...backendOptions,
      cwd: ctx.cwd,
      ...(ctx.resumeToken ? { resume: ctx.resumeToken } : {}),
    };

    const run = streamClaudeAgent(ctx.prompt, options, controller.signal);
    run.sessionId
      .then((id) => {
        latestSessionId = id;
      })
      .catch(() => undefined);

    // Settled only from `chunks`'s `finally` below, when the caller abandons
    // the stream before the turn ends. `run.result` cannot be relied on to
    // reject on its own in that case: agent.ts's generator walks its inner
    // iterator with a plain `for` loop rather than `for await...of`, so an
    // externally invoked `.return()` on `run.chunks` does not cascade down
    // to close the CLI's own message generator — it is simply abandoned,
    // mid-iteration, and never driven forward again to reach the code that
    // rejects `run.result`. This is the transport-level twin of the bug
    // already fixed once in FakeBackend.
    const abandonment = Promise.withResolvers<TurnResult>();
    abandonment.promise.catch(() => undefined);

    const transportResult: Promise<TurnResult> = run.result.then(
      (terminal) => ({
        finishReason: toFinishReason(terminal),
        isError: terminal.is_error,
        usage: toRunUsage(terminal),
        costUsd: terminal.total_cost_usd,
        resumeToken: terminal.session_id,
      }),
      (error): TurnResult => {
        // A steer aborts the process on purpose; report it as a clean,
        // steered stop rather than an error.
        if (steerText !== undefined && isAbortError(error)) {
          return buildSteeredResult(steerText);
        }
        throw error;
      },
    );

    const result: Promise<TurnResult> = Promise.race([
      transportResult,
      abandonment.promise,
    ]);
    // The workflow may consume chunks and result independently; an interrupt
    // rejection must not become an unhandled rejection before it is awaited.
    result.catch(() => undefined);
    // Also remove the outer-abort forwarder once `result` settles: a caller
    // that never touches `chunks` at all (only awaits `result`) would
    // otherwise leave it attached to `ctx.abortSignal` forever. Idempotent
    // with the same removal in `chunks()`'s `finally` below.
    result
      .finally(() => {
        ctx.abortSignal?.removeEventListener("abort", onOuterAbort);
      })
      .catch(() => undefined);

    async function* chunks(): AsyncGenerator<UIMessageChunk> {
      let completed = false;
      try {
        for await (const chunk of run.chunks) {
          yield chunk;
        }
        completed = true;
      } catch (error) {
        // Aborts (steer or interrupt) end the stream; result carries the
        // outcome. Anything else propagates.
        completed = true;
        if (!isAbortError(error)) {
          throw error;
        }
      } finally {
        ctx.abortSignal?.removeEventListener("abort", onOuterAbort);
        if (!completed) {
          // The caller stopped consuming before the turn ended (a bare
          // `break`, or simply never draining the stream). The CONTRACT
          // treats this as equivalent to interrupt(): make sure `result`
          // still settles instead of dangling — see the comment on
          // `abandonment` above for why `transportResult` alone can't be
          // trusted to do that here. A steer already in flight still wins,
          // exactly as it would via the normal drained path.
          controller.abort();
          if (steerText !== undefined) {
            abandonment.resolve(buildSteeredResult(steerText));
          } else {
            abandonment.reject(abortError());
          }
        }
      }
    }

    return {
      chunks: chunks(),
      result,
      steer: (text: string) => {
        steerText = text;
        controller.abort();
        return Promise.resolve();
      },
      interrupt: () => {
        controller.abort();
      },
    };
  }
}
