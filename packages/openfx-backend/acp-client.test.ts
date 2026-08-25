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
});
