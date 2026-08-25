import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AcpClient,
  AcpError,
  type PermissionRequestParams,
} from "./acp-client.ts";

const STUB_PATH = join(import.meta.dir, "test", "stub-acp-server.ts");

interface StubOptions {
  script?: unknown;
  slow?: boolean;
  hangOnClose?: boolean;
  ignoreSigterm?: boolean;
  exitBeforeResponse?: boolean;
  closeTimeoutsMs?: { graceful?: number; term?: number };
}

const clientsToClose: AcpClient[] = [];

afterEach(async () => {
  await Promise.all(clientsToClose.splice(0).map((client) => client.close()));
});

function createClient(options: StubOptions = {}): AcpClient {
  const env: Record<string, string> = {};
  if (options.script !== undefined) {
    env.ACP_STUB_SCRIPT = JSON.stringify(options.script);
  }
  if (options.slow) {
    env.ACP_STUB_SLOW = "1";
  }
  if (options.hangOnClose) {
    env.ACP_STUB_HANG_ON_CLOSE = "1";
  }
  if (options.ignoreSigterm) {
    env.ACP_STUB_IGNORE_SIGTERM = "1";
  }
  if (options.exitBeforeResponse) {
    env.ACP_STUB_EXIT_BEFORE_RESPONSE = "1";
  }

  const client = new AcpClient({
    cwd: process.cwd(),
    executable: process.execPath,
    extraArgs: [STUB_PATH],
    env,
    closeTimeoutsMs: options.closeTimeoutsMs,
  });
  clientsToClose.push(client);
  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function kindOf(update: unknown): string {
  return isRecord(update) && typeof update.kind === "string" ? update.kind : "";
}

async function handshake(client: AcpClient): Promise<string> {
  await client.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  const session = await client.newSession();
  return session.sessionId;
}

/** Reads `client.updates` into `out` in the background until the client closes. */
function drainUpdatesInBackground(client: AcpClient, out: unknown[]): void {
  void (async () => {
    for await (const envelope of client.updates) {
      out.push(envelope.update);
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Captures process-level `unhandledRejection`/`uncaughtException` while
 * `run` executes, so a test can prove a race didn't crash the host instead
 * of just checking its own local promises. `bun:test` doesn't currently
 * fail a run on these by itself, which is exactly why the transport itself
 * has to guard against producing them.
 */
async function withUnhandledErrorProbe(
  run: () => Promise<void>,
): Promise<unknown[]> {
  const captured: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => captured.push(reason);
  const onUncaughtException = (error: unknown) => captured.push(error);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  try {
    await run();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
  }
  return captured;
}

describe("AcpClient", () => {
  test("handshake completes and session/new returns a session id", async () => {
    const client = createClient({ script: {} });
    const updates: unknown[] = [];
    drainUpdatesInBackground(client, updates);

    const init = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities.loadSession).toBe(true);

    const session = await client.newSession();
    expect(session.sessionId).toMatch(/^stub-session-/);

    await sleep(20);
    expect(updates.map(kindOf)).toEqual(["available_commands_update"]);
  });

  test("session/load returns configOptions and modes without a sessionId field", async () => {
    const client = createClient({ script: {} });
    await handshake(client);
    const loaded = await client.loadSession({
      sessionId: "some-prior-session",
    });
    expect(loaded).not.toHaveProperty("sessionId");
    expect(loaded.modes.currentModeId).toBe("default");
  });

  test("prompt streams scripted updates in order, then resolves with stopReason", async () => {
    const client = createClient({
      script: {
        steps: [
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "Hel" },
            },
          },
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "lo" },
            },
          },
          {
            kind: "update",
            update: {
              kind: "tool_call",
              toolCallId: "t1",
              title: "Read file",
              status: "pending",
            },
          },
        ],
        stopReason: "end_turn",
      },
    });
    const updates: unknown[] = [];
    const sessionId = await handshake(client);
    drainUpdatesInBackground(client, updates);

    const result = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(result.stopReason).toBe("end_turn");
    await sleep(20);
    expect(updates.map(kindOf)).toEqual([
      "available_commands_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "tool_call",
    ]);
  });

  test("a server-initiated permission request round-trips through the handler", async () => {
    const received: PermissionRequestParams[] = [];
    const client = createClient({
      script: {
        steps: [
          {
            kind: "permission",
            permission: {
              toolCall: {
                toolCallId: "t1",
                title: "Write file",
                kind: "edit",
                status: "pending",
                rawInput: { path: "a.txt" },
              },
              options: [
                {
                  optionId: "allow_once",
                  name: "Allow once",
                  kind: "allow_once",
                },
                {
                  optionId: "reject_once",
                  name: "Reject",
                  kind: "reject_once",
                },
              ],
            },
          },
        ],
        stopReason: "end_turn",
      },
    });

    client.onPermissionRequest((request) => {
      received.push(request);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });

    const updates: unknown[] = [];
    const sessionId = await handshake(client);
    drainUpdatesInBackground(client, updates);

    const result = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(result.stopReason).toBe("end_turn");
    expect(received).toHaveLength(1);
    expect(received[0]?.toolCall.toolCallId).toBe("t1");
    expect(received[0]?.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);

    await sleep(20);
    const echo = updates.find((update) => kindOf(update) === "permission_echo");
    expect(echo).toBeDefined();
    expect(echo).toMatchObject({
      decision: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
  });

  test("cancel mid-turn (slow mode) ends the turn with stopReason cancelled", async () => {
    const client = createClient({
      slow: true,
      script: {
        steps: [
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "a" },
            },
          },
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "b" },
            },
          },
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "c" },
            },
          },
        ],
        slowStepDelayMs: 100,
      },
    });

    const updates: unknown[] = [];
    const sessionId = await handshake(client);
    drainUpdatesInBackground(client, updates);

    const promptPromise = client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    // First step's update lands around t=100ms; cancel partway through the
    // second step's delay so the turn is cancelled mid-stream, not before or
    // after all scripted updates were sent.
    await sleep(150);
    client.cancel(sessionId);

    const result = await promptPromise;
    expect(result.stopReason).toBe("cancelled");

    await sleep(20);
    const chunkUpdates = updates.filter(
      (update) => kindOf(update) === "agent_message_chunk",
    );
    expect(chunkUpdates.length).toBeGreaterThan(0);
    expect(chunkUpdates.length).toBeLessThan(3);
  });

  test("process exit without a response rejects pending requests with AcpError", async () => {
    const client = createClient({ exitBeforeResponse: true });
    const sessionId = await handshake(client);

    await expect(
      client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(AcpError);
  });

  test("a malformed line from the server is skipped, not fatal", async () => {
    const client = createClient({
      script: {
        steps: [
          { kind: "raw", line: "not-json-at-all-{{{" },
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "ok" },
            },
          },
        ],
        stopReason: "end_turn",
      },
    });

    const updates: unknown[] = [];
    const sessionId = await handshake(client);
    drainUpdatesInBackground(client, updates);

    const result = await client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(result.stopReason).toBe("end_turn");
    await sleep(20);
    expect(
      updates.some((update) => kindOf(update) === "agent_message_chunk"),
    ).toBe(true);
  });

  test("close() escalates from graceful shutdown to SIGTERM to SIGKILL", async () => {
    const client = createClient({
      hangOnClose: true,
      ignoreSigterm: true,
      closeTimeoutsMs: { graceful: 50, term: 50 },
    });
    await handshake(client);

    await client.close();

    expect(client.process.signalCode).toBe("SIGKILL");
  });

  test("close() is graceful (no signal) when the process exits on stdin EOF", async () => {
    const client = createClient({ script: {} });
    await handshake(client);

    await client.close();

    expect(client.process.signalCode).toBeNull();
    expect(client.process.exitCode).toBe(0);
  });

  test("cancel() racing process teardown does not crash the host", async () => {
    const client = createClient({ script: {} });
    const sessionId = await handshake(client);

    const captured = await withUnhandledErrorProbe(async () => {
      client.process.kill("SIGKILL");
      // The race: call cancel() immediately, before this client has
      // necessarily observed the process's own death — a write against a
      // dying/dead stdin must be a no-op, never a crash.
      expect(() => client.cancel(sessionId)).not.toThrow();
      await new Promise((resolve) => client.process.once("close", resolve));
      await sleep(20);
    });

    expect(captured).toEqual([]);
  });

  test("a stream error during the read loop rejects pending requests, not an unhandled rejection", async () => {
    const client = createClient({ script: {} });
    const sessionId = await handshake(client);

    const pending = client.prompt({
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    // Attached synchronously, right after the promise is created, so this
    // test's own bookkeeping can never manufacture an unhandled rejection
    // during the probe window below — the thing under test is whether
    // AcpClient itself produces one, not whether this assertion is late.
    const settled = pending.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const captured = await withUnhandledErrorProbe(async () => {
      // Forces the read loop's `for await` to throw, simulating a stream
      // failure the process itself didn't cause.
      client.process.stdout.emit(
        "error",
        new Error("simulated stream failure"),
      );
      await sleep(20);
    });

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(AcpError);
    }
    expect(captured).toEqual([]);
  });

  test("the update queue drops the oldest entry and warns once per overflow episode", async () => {
    const steps = Array.from({ length: 10_005 }, (_, index) => ({
      kind: "update" as const,
      update: {
        kind: "agent_message_chunk",
        content: { type: "text", text: `${index}` },
      },
    }));
    const client = createClient({ script: { steps, stopReason: "end_turn" } });
    const sessionId = await handshake(client);

    // No background drain: every update piles up in the queue, forcing the
    // 10,000-entry cap to kick in before the test reads any of them.
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let result: { stopReason: string };
    try {
      result = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(result.stopReason).toBe("end_turn");
    expect(warnings.length).toBe(1);

    const collected: unknown[] = [];
    for await (const envelope of client.updates) {
      collected.push(envelope.update);
      if (collected.length >= 10_000) {
        break;
      }
    }
    // The available_commands_update from session/new plus 10,005 scripted
    // updates is 10,006 total; capped at 10,000, so the oldest 6 (the
    // available_commands_update and the first five scripted ones) were
    // dropped — the surviving oldest entry is scripted update index 5.
    expect(kindOf(collected[0])).toBe("agent_message_chunk");
    expect(
      isRecord(collected[0]) && isRecord(collected[0].content)
        ? collected[0].content.text
        : undefined,
    ).toBe("5");
  });

  test("an oversized inbound line (over the 8MB frame limit) is skipped, not fatal", async () => {
    const client = createClient({
      script: {
        steps: [
          { kind: "raw-oversized", bytes: 9 * 1024 * 1024 },
          {
            kind: "update",
            update: {
              kind: "agent_message_chunk",
              content: { type: "text", text: "ok" },
            },
          },
        ],
        stopReason: "end_turn",
      },
    });

    const updates: unknown[] = [];
    const sessionId = await handshake(client);
    drainUpdatesInBackground(client, updates);

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let result: { stopReason: string };
    try {
      result = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(result.stopReason).toBe("end_turn");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    await sleep(50);
    expect(
      updates.some((update) => kindOf(update) === "agent_message_chunk"),
    ).toBe(true);
  });
});
