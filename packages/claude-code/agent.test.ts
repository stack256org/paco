import { describe, expect, mock, test } from "bun:test";
import type { ClaudeCodeOptions } from "./options.ts";
import type { ClaudeMessage, ClaudeResultMessage } from "./types.ts";

/**
 * Scripts one CLI run per call, so a turn can be made to fail its resume and
 * succeed on the retry without spawning anything.
 */
const spawns: ClaudeCodeOptions[] = [];
let scripted: ClaudeMessage[][] = [];

/** Set to drive a run that stays open until the test releases it. */
let hangingRun: { messages: AsyncIterable<ClaudeMessage> } | null = null;

mock.module("./run.ts", () => ({
  runClaudeCode: (_prompt: string, options: ClaudeCodeOptions) => {
    spawns.push(options);
    if (hangingRun) {
      return {
        messages: hangingRun.messages,
        result: new Promise<ClaudeResultMessage>(() => {
          // Never settles; the test only inspects the chunk stream.
        }),
        sessionId: Promise.resolve("s"),
        process: undefined as never,
      };
    }
    const messages = scripted[spawns.length - 1] ?? [];
    const result = messages.find(
      (m): m is ClaudeResultMessage => m.type === "result",
    );

    return {
      messages: (async function* () {
        for (const message of messages) {
          yield message;
        }
      })(),
      result: result
        ? Promise.resolve(result)
        : Promise.reject(new Error("no result")),
      sessionId: Promise.resolve(result?.session_id ?? "unknown"),
      process: undefined as never,
    };
  },
}));

const { streamClaudeAgent } = await import("./agent.ts");

function init(sessionId: string): ClaudeMessage {
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
  } as unknown as ClaudeMessage;
}

function terminal(overrides: Partial<ClaudeResultMessage>): ClaudeMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    session_id: "new-session",
    uuid: "u",
    ...overrides,
  } as ClaudeMessage;
}

const MISSING_SESSION = terminal({
  is_error: true,
  subtype: "error_during_execution",
  session_id: "stale-session",
  errors: ["No conversation found with session ID: stale-session"],
});

/** Reset the recorder and queue one scripted CLI run per spawn. */
function script(...runs: ClaudeMessage[][]) {
  spawns.length = 0;
  scripted = runs;
}

/**
 * Wraps an async generator so a test can observe whether its `.return()` was
 * invoked, without mutating the generator itself.
 */
function trackReturn<T>(source: AsyncGenerator<T>): {
  messages: AsyncIterable<T>;
  returnCalled: () => boolean;
} {
  let called = false;
  return {
    messages: {
      [Symbol.asyncIterator]() {
        return {
          next: () => source.next(),
          return: (value?: unknown) => {
            called = true;
            return source.return(value as never);
          },
        };
      },
    },
    returnCalled: () => called,
  };
}

async function drain(options: ClaudeCodeOptions) {
  const run = streamClaudeAgent("hello", options);
  const chunks = [];
  for await (const chunk of run.chunks) {
    chunks.push(chunk);
  }
  return { chunks, result: await run.result };
}

describe("streamClaudeAgent", () => {
  test("retries without resume when the session no longer exists", async () => {
    // Claude Code scopes a session to the directory it ran in, so a stored id
    // stops resolving the moment a chat's worktree changes. Unhandled, the
    // turn reaches the user as an empty message with zero tokens.
    script(
      [MISSING_SESSION],
      [init("new-session"), terminal({ result: "done" })],
    );

    const { result } = await drain({ cwd: "/ws", resume: "stale-session" });

    expect(spawns).toHaveLength(2);
    expect(spawns[0]?.resume).toBe("stale-session");
    expect(spawns[1]?.resume).toBeUndefined();
    expect(result.is_error).toBe(false);
  });

  test("reports the retry's session id, not the stale one", async () => {
    script(
      [MISSING_SESSION],
      [init("new-session"), terminal({ result: "done" })],
    );

    const run = streamClaudeAgent("hello", {
      cwd: "/ws",
      resume: "stale-session",
    });
    for await (const _ of run.chunks) {
      // drain
    }

    // Persisting the stale id would make every later turn fail the same way.
    expect(await run.sessionId).toBe("new-session");
  });

  test("does not retry a genuine execution failure", async () => {
    // Dropping resume here would silently discard the CLI's history.
    script([
      init("live-session"),
      terminal({
        is_error: true,
        subtype: "error_during_execution",
        errors: ["Tool 'Bash' failed"],
      }),
    ]);

    await drain({ cwd: "/ws", resume: "live-session" });

    expect(spawns).toHaveLength(1);
  });

  test("does not retry when no resume was requested", async () => {
    script([MISSING_SESSION]);

    await drain({ cwd: "/ws" });

    expect(spawns).toHaveLength(1);
  });

  test("streams a turn instead of buffering it to the end", async () => {
    // The resume check peeks one message. It must not turn into buffering the
    // whole turn: the UI would then show nothing until the agent stopped.
    const finishTurn = Promise.withResolvers<undefined>();
    scripted = [];
    spawns.length = 0;
    hangingRun = {
      messages: (async function* () {
        yield init("s");
        yield assistantText("partial");
        await finishTurn.promise;
        yield terminal({ result: "done" });
      })(),
    };

    const run = streamClaudeAgent("hello", { cwd: "/ws" });
    const iterator = run.chunks[Symbol.asyncIterator]();

    // Arrives while the turn is still running.
    const first = await iterator.next();
    expect(first.done).toBe(false);

    finishTurn.resolve(undefined);
    hangingRun = null;
  });

  test("abandoning run.chunks cascades to close the inner run.messages iterator", async () => {
    // A caller that stops draining `chunks` before the turn ends (a bare
    // `break`) must not orphan the CLI's own message generator — its
    // `finally` is what closes `rl` and sends SIGTERM in run.ts.
    scripted = [];
    spawns.length = 0;
    const tracked = trackReturn(
      (async function* () {
        yield init("s");
        yield assistantText("partial");
        // Never yields a terminal result on its own; only closing the
        // iterator should end this turn.
      })(),
    );
    hangingRun = tracked;

    const run = streamClaudeAgent("hello", { cwd: "/ws" });
    const iterator = run.chunks[Symbol.asyncIterator]();

    await iterator.next(); // one UI chunk, from the assistant text message
    await iterator.return?.();

    expect(tracked.returnCalled()).toBe(true);
    hangingRun = null;
  });
});
