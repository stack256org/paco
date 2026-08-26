import { describe, expect, mock, test } from "bun:test";
import type { TurnContext } from "@paco/agent-backend";
import { runBackendConformance } from "@paco/agent-backend/conformance.js";
import type { ClaudeCodeOptions } from "./options.ts";
import type { ClaudeMessage, ClaudeResultMessage } from "./types.ts";

/**
 * Fakes the CLI the same way agent.test.ts does: `runClaudeCode` is replaced
 * so no process is spawned. Each call reads the next scripted run off
 * `stubRuns` (one per `startTurn`), always emitting `init` and its `chunks`
 * messages immediately, then racing a delay (natural completion) against the
 * abort signal — mirroring run.ts's real SIGTERM behavior: aborted first,
 * `result` rejects with `name: "AbortError"` and the message stream throws
 * the same error; otherwise the terminal `result` message resolves it.
 */
interface StubRun {
  sessionId: string;
  /** Extra protocol messages emitted after `init`, before the terminal race. */
  chunks?: ClaudeMessage[];
  /** ms to wait before emitting the terminal `result`, if never aborted. */
  delayMs?: number;
  result?: Partial<ClaudeResultMessage>;
}

let stubRuns: StubRun[] = [];
let stubCalls: ClaudeCodeOptions[] = [];
/** One entry per `runClaudeCode` call: did its eager abort listener fire? */
let killedCalls: boolean[] = [];

function abortError(): Error {
  const error = new Error("Claude Code run was aborted");
  error.name = "AbortError";
  return error;
}

function initMessage(sessionId: string): ClaudeMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as ClaudeMessage;
}

function assistantText(text: string): ClaudeMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  } as unknown as ClaudeMessage;
}

mock.module("./run.ts", () => ({
  runClaudeCode: (
    _prompt: string,
    options: ClaudeCodeOptions,
    signal?: AbortSignal,
  ) => {
    stubCalls.push(options);
    const callIndex = stubCalls.length - 1;
    const scripted = stubRuns[callIndex];
    if (!scripted) {
      throw new Error("backend.test.ts: no stub run configured for this call");
    }
    // Reassigned to a variable TypeScript can prove non-nullable inside the
    // `iterate` closure below (narrowing on `scripted` itself doesn't survive
    // capture by a nested function).
    const config: StubRun = scripted;

    const resultDeferred = Promise.withResolvers<ClaudeResultMessage>();
    const sessionDeferred = Promise.withResolvers<string>();

    // Registered eagerly, at "spawn" time — exactly like run.ts's own
    // `runClaudeCode`, which wires its SIGTERM listener immediately rather
    // than waiting for the message stream to be read. This is what makes
    // `killedCalls` a real proof that abandonment reaches the transport's
    // abort handling, instead of only exercising backend.ts's bookkeeping:
    // a listener installed lazily inside `iterate()` below would never fire
    // for a run that's abandoned before that code executes.
    killedCalls[callIndex] = false;
    const aborted = Promise.withResolvers<undefined>();
    const onAbort = () => {
      killedCalls[callIndex] = true;
      aborted.resolve(undefined);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    async function* iterate(): AsyncGenerator<ClaudeMessage> {
      yield initMessage(config.sessionId);
      sessionDeferred.resolve(config.sessionId);

      for (const message of config.chunks ?? []) {
        yield message;
      }

      const delayMs = config.delayMs ?? 0;
      const timedOut = new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      const outcome = await Promise.race([
        aborted.promise.then(() => "aborted" as const),
        timedOut.then(() => "timedOut" as const),
      ]);

      if (outcome === "aborted") {
        const error = abortError();
        resultDeferred.reject(error);
        throw error;
      }

      const terminal: ClaudeResultMessage = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        num_turns: 1,
        session_id: config.sessionId,
        uuid: "stub-uuid",
        ...config.result,
      };
      resultDeferred.resolve(terminal);
      yield terminal;
    }

    return {
      messages: iterate(),
      result: resultDeferred.promise,
      sessionId: sessionDeferred.promise,
      process: undefined as never,
    };
  },
}));

const { ClaudeCodeBackend } = await import("./backend.ts");

/** Reset the recorder and queue one scripted CLI run per `startTurn` call. */
function script(...runs: StubRun[]) {
  stubCalls.length = 0;
  killedCalls.length = 0;
  stubRuns = runs;
}

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: "/ws", prompt: "hello", ...overrides };
}

describe("ClaudeCodeBackend", () => {
  test("streams mapped chunks and resolves usage, resumeToken, finishReason", async () => {
    script({
      sessionId: "scripted-session-1",
      chunks: [assistantText("hello from stub")],
      delayMs: 0,
      result: { usage: { input_tokens: 11, output_tokens: 17 } },
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    const result = await handle.result;

    expect(
      chunks.some(
        (c) => c.type === "text-delta" && c.delta === "hello from stub",
      ),
    ).toBe(true);
    expect(result.finishReason).toBe("stop");
    expect(result.isError).toBe(false);
    expect(result.resumeToken).toBe("scripted-session-1");
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(17);
  });

  test("surfaces the terminal message's structured_output on the result", async () => {
    script({
      sessionId: "scripted-session-2",
      result: { structured_output: { tasks: [{ title: "t", goal: "g" }] } },
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    for await (const _chunk of handle.chunks) {
      // drain: result only settles once chunks are fully consumed
    }
    const result = await handle.result;

    expect(result.structuredOutput).toEqual({
      tasks: [{ title: "t", goal: "g" }],
    });
  });

  test("omits structuredOutput when the terminal message carries none", async () => {
    script({ sessionId: "scripted-session-3" });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    for await (const _chunk of handle.chunks) {
      // drain: result only settles once chunks are fully consumed
    }
    const result = await handle.result;

    expect(result.structuredOutput).toBeUndefined();
  });

  test("interrupt(): result rejects with name AbortError", async () => {
    script({
      sessionId: "s",
      chunks: [assistantText("working")],
      delayMs: 10_000,
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    // Let the first chunk land before interrupting mid-run, per the stub's
    // sleep between init and result.
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    handle.interrupt();

    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("steer(text): result RESOLVES steered despite the SIGTERM", async () => {
    script({
      sessionId: "s",
      chunks: [assistantText("working")],
      delayMs: 10_000,
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await handle.steer("new text");

    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    const result = await handle.result;
    expect(result.steered).toEqual({ text: "new text" });
    expect(result.isError).toBe(false);
    expect(result.finishReason).toBe("stop");
  });

  test("carries mcpServers from backendOptions through to the CLI options", async () => {
    script({
      sessionId: "s-mcp",
      chunks: [assistantText("hi")],
      delayMs: 0,
    });

    const mcpServers = {
      "paco-plugins": {
        command: "/usr/bin/node",
        args: ["scripts/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    };

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(
      turnContext({ backendOptions: { mcpServers } }),
    );

    for await (const _chunk of handle.chunks) {
      // Drain to completion.
    }
    await handle.result;

    expect(stubCalls.at(-1)?.mcpServers).toEqual(mcpServers);
  });

  test("capabilities() declares the claude-code backend", () => {
    const backend = new ClaudeCodeBackend();
    expect(backend.capabilities()).toEqual({
      id: "claude-code",
      resume: true,
      steering: "restart",
      mcp: true,
      effort: true,
      subagents: true,
      // True: the CLI's `Read` renders an image for the model, which is what
      // the attachment path stages a PNG to disk for.
      images: true,
    });
  });

  test("abandoning chunks before the turn ends rejects result with AbortError", async () => {
    // Per interface.ts's TurnHandle CONTRACT: abandoning `chunks` before the
    // turn ends is equivalent to interrupt(). Consume exactly one chunk from
    // a slow stub run, then stop draining without steering or interrupting.
    script({
      sessionId: "s",
      chunks: [assistantText("working")],
      delayMs: 10_000,
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    // Equivalent to `for await (const chunk of handle.chunks) { break; }`,
    // written explicitly so the single-iteration loop doesn't trip the
    // no-unreachable-loop lint rule.
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
    // Proves abandonment reached the transport's abort handling (the thing
    // that would send SIGTERM), not just backend.ts's own bookkeeping.
    expect(killedCalls[0]).toBe(true);
  });

  test("steer() then abandoning chunks still RESOLVES steered", async () => {
    // The companion case: a steer already in flight must still win over the
    // abandonment path's plain AbortError.
    script({
      sessionId: "s",
      chunks: [assistantText("working")],
      delayMs: 10_000,
    });

    const backend = new ClaudeCodeBackend();
    const handle = backend.startTurn(turnContext());

    await handle.steer("steered text");
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    const result = await handle.result;
    expect(result.steered).toEqual({ text: "steered text" });
    expect(result.isError).toBe(false);
    // Same proof as above: the kill path was reached even though the
    // outcome here is a successful steer, not a rejection.
    expect(killedCalls[0]).toBe(true);
  });
});

describe("ClaudeCodeBackend conformance", () => {
  runBackendConformance("claude-code", () => {
    script({
      sessionId: "conformance-session",
      chunks: [assistantText("hello from stub")],
      delayMs: 10_000,
    });

    return {
      backend: new ClaudeCodeBackend(),
      turnContext: turnContext({ prompt: "conformance prompt" }),
    };
  });
});
