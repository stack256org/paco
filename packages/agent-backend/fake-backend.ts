import type { UIMessageChunk } from "ai";
import { zeroUsage } from "./events.ts";
import {
  type AgentBackend,
  type BackendCapabilities,
  SteeringUnsupportedError,
  type TurnContext,
  type TurnHandle,
  type TurnResult,
} from "./interface.ts";

export interface FakeBackendConfig {
  /** Chunks to emit, in order. */
  script: UIMessageChunk[];
  /** Keep the turn open after the script until steer/interrupt/abort. */
  holdOpen?: boolean;
  steering?: "restart" | "none";
  resumeToken?: string;
}

function abortError(): Error {
  const error = new Error("Turn was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Scripted in-memory backend for tests and the conformance suite. Emits its
 * script, then either finishes or (holdOpen) waits for steer/interrupt.
 */
export class FakeBackend implements AgentBackend {
  private readonly config: FakeBackendConfig;

  constructor(config: FakeBackendConfig) {
    this.config = config;
  }

  capabilities(): BackendCapabilities {
    return {
      id: "fake",
      resume: true,
      steering: this.config.steering ?? "restart",
      mcp: false,
      effort: false,
      subagents: false,
    };
  }

  startTurn(ctx: TurnContext): TurnHandle {
    const { script, holdOpen, resumeToken } = this.config;
    const steering = this.config.steering ?? "restart";
    const resultDeferred = Promise.withResolvers<TurnResult>();
    // `resultDeferred` is settled from inside the chunk generator below, as a
    // side effect of consuming `chunks` — a consumer that fully drains
    // `chunks` before attaching its own handler to `result` (e.g. via
    // `expect(collect(handle.chunks)).resolves...` without an immediate
    // await) can otherwise trip an unhandled-rejection report on abort. A
    // silent internal observer here absorbs that without affecting what
    // external `.then()`/`await` consumers of `result` see.
    resultDeferred.promise.catch(() => {
      // Intentionally empty: see comment above.
    });
    // Settled when something ends the held-open phase.
    const release = Promise.withResolvers<
      { kind: "steer"; text: string } | { kind: "abort" } | { kind: "end" }
    >();

    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        release.resolve({ kind: "abort" });
      } else {
        ctx.abortSignal.addEventListener(
          "abort",
          () => release.resolve({ kind: "abort" }),
          { once: true },
        );
      }
    }

    const token = resumeToken ?? "fake-session-1";

    async function* chunks(): AsyncGenerator<UIMessageChunk> {
      // Tracks whether `resultDeferred` has been settled, so the `finally`
      // below can tell a normal completion from early abandonment.
      let settled = false;
      const resolve = (result: TurnResult) => {
        settled = true;
        resultDeferred.resolve(result);
      };
      const reject = (error: Error) => {
        settled = true;
        resultDeferred.reject(error);
      };

      try {
        for (const chunk of script) {
          yield chunk;
        }
        const outcome = holdOpen
          ? await release.promise
          : await Promise.race([
              release.promise,
              Promise.resolve({ kind: "end" as const }),
            ]);

        if (outcome.kind === "abort") {
          reject(abortError());
          return;
        }
        if (outcome.kind === "steer") {
          resolve({
            finishReason: "stop",
            isError: false,
            usage: zeroUsage(),
            resumeToken: token,
            steered: { text: outcome.text },
          });
          return;
        }
        resolve({
          finishReason: "stop",
          isError: false,
          usage: zeroUsage(),
          resumeToken: token,
        });
      } finally {
        // A consumer that abandons `chunks` early (break/return/throw on the
        // iterator) resumes this generator via an implicit `return` at the
        // paused `yield`, running this block without the code above ever
        // settling `resultDeferred`. Per contract, that is equivalent to
        // `interrupt()`: `result` rejects with an AbortError rather than
        // hanging forever.
        if (!settled) {
          reject(abortError());
        }
      }
    }

    return {
      chunks: chunks(),
      result: resultDeferred.promise,
      steer: (text: string) => {
        if (steering === "none") {
          return Promise.reject(new SteeringUnsupportedError("fake"));
        }
        release.resolve({ kind: "steer", text });
        return Promise.resolve();
      },
      interrupt: () => {
        release.resolve({ kind: "abort" });
      },
    };
  }
}
