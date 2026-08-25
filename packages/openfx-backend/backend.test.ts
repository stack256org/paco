import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnContext } from "@paco/agent-backend";
import { runBackendConformance } from "@paco/agent-backend/conformance.js";
import { describe, expect, spyOn, test } from "bun:test";
import type {
  PermissionDecision,
  PermissionRequestParams,
} from "./acp-client.ts";
import {
  denyPermissionHandler,
  OpenFxBackend,
  type OpenFxBackendConfig,
  type OpenFxBackendOptions,
} from "./backend.ts";
import { AcpChunkMapper } from "./chunk-mapper.ts";

const STUB_PATH = join(import.meta.dir, "test", "stub-acp-server.ts");

function stubConfig(
  script: unknown,
  extraEnv: Record<string, string> = {},
): OpenFxBackendConfig {
  return {
    executable: process.execPath,
    extraArgs: [STUB_PATH],
    env: { ACP_STUB_SCRIPT: JSON.stringify(script), ...extraEnv },
    // Short escalation timeouts so a test that DOES hit the graceful/SIGTERM
    // path (rather than the fast stdin-EOF exit) doesn't sit around for the
    // production defaults (3s/2s).
    closeTimeoutsMs: { graceful: 300, term: 300 },
  };
}

function turnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return { cwd: process.cwd(), prompt: "hello", ...overrides };
}

function agentMessageChunk(text: string): unknown {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}

/**
 * A script whose first step streams immediately (`delayMs: 0`, proving a
 * real chunk arrives) and whose second step falls back to a long
 * script-level delay — interruptible by session/cancel (see
 * stub-acp-server.ts) — so the turn stays open long enough for
 * steer()/interrupt() to land instead of finishing on its own. Mirrors
 * ClaudeCodeBackend's conformance factory, which holds its stubbed CLI run
 * open via a 10_000ms `delayMs`.
 */
const HOLD_OPEN_SCRIPT = {
  steps: [
    {
      kind: "update",
      update: agentMessageChunk("hello from openfx stub"),
      delayMs: 0,
    },
    { kind: "update", update: agentMessageChunk(" more") },
  ],
  stepDelayMs: 10_000,
  stopReason: "end_turn",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

describe("OpenFxBackend", () => {
  test("streams mapped chunks and resolves usage zeros, resumeToken = session id", async () => {
    const backend = new OpenFxBackend(
      stubConfig({
        steps: [
          { kind: "update", update: agentMessageChunk("hello from stub") },
        ],
        stopReason: "end_turn",
      }),
    );
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
    expect(chunks.some((c) => c.type === "text-end")).toBe(true);
    expect(result.finishReason).toBe("stop");
    expect(result.isError).toBe(false);
    // PROTOCOL.md §6: no usage/cost on the wire — always zeros.
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    });
    expect(result.costUsd).toBeUndefined();
    // PROTOCOL.md §4/§7: the ACP sessionId is the durable resume handle.
    expect(typeof result.resumeToken).toBe("string");
    expect((result.resumeToken ?? "").length).toBeGreaterThan(0);
  });

  test("result stays pending until chunks are fully drained, even on a fast (no hold-open) script", async () => {
    // No HOLD_OPEN_SCRIPT here on purpose: the real ACP turn (init +
    // session/new + prompt, all local) finishes essentially immediately.
    // `chunks` is never touched below until well after that — proving
    // `result` doesn't settle just because the underlying transport did.
    const backend = new OpenFxBackend(
      stubConfig({
        steps: [{ kind: "update", update: agentMessageChunk("fast") }],
        stopReason: "end_turn",
      }),
    );
    const handle = backend.startTurn(turnContext());

    let settled = false;
    handle.result
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    // Real wall-clock wait, comfortably longer than the actual (local,
    // in-process) ACP turn takes to finish end-to-end — nothing here reads
    // `chunks` yet.
    await sleep(300);
    expect(settled).toBe(false);

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    // Let the `.then` callback above actually run.
    await sleep(0);
    expect(settled).toBe(true);

    const result = await handle.result;
    expect(
      chunks.some((c) => c.type === "text-delta" && c.delta === "fast"),
    ).toBe(true);
    expect(result.finishReason).toBe("stop");
  });

  test("abandonment calls mapper.finish() for state consistency, even though its output is discarded", async () => {
    const finishSpy = spyOn(AcpChunkMapper.prototype, "finish");
    try {
      const backend = new OpenFxBackend(stubConfig(HOLD_OPEN_SCRIPT));
      const handle = backend.startTurn(turnContext());

      // Opens a text block (HOLD_OPEN_SCRIPT's first step), then abandon
      // before the turn ends.
      const iterator = handle.chunks[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      await handle.result.catch(() => undefined);

      expect(finishSpy).toHaveBeenCalled();
    } finally {
      finishSpy.mockRestore();
    }
  });

  test("interrupt(): cancel + kill; result rejects with name AbortError", async () => {
    const backend = new OpenFxBackend(stubConfig(HOLD_OPEN_SCRIPT));
    const handle = backend.startTurn(turnContext());

    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    handle.interrupt();

    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });
  });

  test("steer(text): result RESOLVES steered", async () => {
    const backend = new OpenFxBackend(stubConfig(HOLD_OPEN_SCRIPT));
    const handle = backend.startTurn(turnContext());

    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await handle.steer("new direction");

    let next = await iterator.next();
    while (!next.done) {
      next = await iterator.next();
    }

    const result = await handle.result;
    expect(result.steered).toEqual({ text: "new direction" });
    expect(result.isError).toBe(false);
    expect(result.finishReason).toBe("stop");
  });

  test("abandoning chunks before the turn ends rejects result with AbortError and kills the process", async () => {
    const pidFile = join(
      tmpdir(),
      `openfx-stub-pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const backend = new OpenFxBackend(
      stubConfig(HOLD_OPEN_SCRIPT, { ACP_STUB_PID_FILE: pidFile }),
    );
    const handle = backend.startTurn(turnContext());

    // Equivalent to `for await (const chunk of handle.chunks) { break; }`,
    // written explicitly to avoid an unreachable-loop lint warning.
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });

    // Proves abandonment actually reached the transport's kill path, not
    // just backend.ts's own bookkeeping.
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    const dead = await waitUntilDead(pid);
    expect(dead).toBe(true);
  });

  test("a server-initiated permission request round-trips through onApprovalRequest", async () => {
    const received: PermissionRequestParams[] = [];
    const script = {
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
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        },
        { kind: "update", update: agentMessageChunk("after permission") },
      ],
      stopReason: "end_turn",
    };
    const onApprovalRequest = (
      request: PermissionRequestParams,
    ): PermissionDecision => {
      received.push(request);
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    };

    const backend = new OpenFxBackend(stubConfig(script));
    const backendOptions: OpenFxBackendOptions = { onApprovalRequest };
    const handle = backend.startTurn(turnContext({ backendOptions }));

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    const result = await handle.result;

    expect(received).toHaveLength(1);
    expect(received[0]?.toolCall.toolCallId).toBe("t1");
    expect(received[0]?.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "reject_once",
    ]);
    expect(result.finishReason).toBe("stop");
    expect(
      chunks.some(
        (c) => c.type === "text-delta" && c.delta === "after permission",
      ),
    ).toBe(true);
  });

  test("without a configured handler, permission requests are denied by default and the turn still completes", async () => {
    const script = {
      steps: [
        {
          kind: "permission",
          permission: {
            toolCall: {
              toolCallId: "t1",
              title: "Write file",
              kind: "edit",
              status: "pending",
              rawInput: {},
            },
            options: [
              {
                optionId: "allow_once",
                name: "Allow once",
                kind: "allow_once",
              },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        },
        { kind: "update", update: agentMessageChunk("after permission") },
      ],
      stopReason: "end_turn",
    };

    const backend = new OpenFxBackend(stubConfig(script));
    const handle = backend.startTurn(turnContext());

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    const result = await handle.result;

    expect(result.finishReason).toBe("stop");
    expect(
      chunks.some(
        (c) => c.type === "text-delta" && c.delta === "after permission",
      ),
    ).toBe(true);
  });

  test("denyPermissionHandler selects reject_once when offered, else cancels", () => {
    const withReject = denyPermissionHandler({
      sessionId: "s",
      toolCall: {
        toolCallId: "t1",
        title: "x",
        kind: "edit",
        status: "pending",
        rawInput: undefined,
      },
      options: [
        { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(withReject).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });

    const withoutReject = denyPermissionHandler({
      sessionId: "s",
      toolCall: {
        toolCallId: "t1",
        title: "x",
        kind: "edit",
        status: "pending",
        rawInput: undefined,
      },
      options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
    });
    expect(withoutReject).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("capabilities() matches PROTOCOL.md §7 exactly", () => {
    const backend = new OpenFxBackend();
    expect(backend.capabilities()).toEqual({
      id: "openfx",
      resume: true,
      steering: "restart",
      mcp: true,
      effort: false,
      subagents: true,
    });
  });
});

describe("OpenFxBackend conformance", () => {
  runBackendConformance("OpenFxBackend", () => ({
    backend: new OpenFxBackend(stubConfig(HOLD_OPEN_SCRIPT)),
    turnContext: turnContext({ prompt: "conformance prompt" }),
  }));
});
