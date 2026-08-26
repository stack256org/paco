import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnContext } from "@paco/agent-backend";
import { runBackendConformance } from "@paco/agent-backend/conformance.js";
import { describe, expect, spyOn, test } from "bun:test";
import type {
  PermissionDecision,
  PermissionRequestParams,
} from "./acp-types.ts";
import {
  allowAllPermissionHandler,
  denyPermissionHandler,
  PoolsideBackend,
  type PoolsideBackendOptions,
} from "./backend.ts";
import { PoolsideChunkMapper } from "./chunk-mapper.ts";
import type { PoolsideBackendConfig } from "./config.ts";

const STUB_PATH = join(import.meta.dir, "test", "stub-pool-acp.ts");

function stubConfig(
  script: unknown,
  extraEnv: Record<string, string> = {},
): PoolsideBackendConfig {
  return {
    executable: process.execPath,
    extraArgs: [STUB_PATH],
    env: { POOL_STUB_SCRIPT: JSON.stringify(script), ...extraEnv },
    // Short escalation timeouts so a test that DOES hit the graceful/
    // SIGTERM path doesn't sit around for the production defaults (3s/2s).
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

/** The `usage` shape a real completed `session/prompt` answers with. */
const REAL_USAGE = {
  cachedReadTokens: 11_568,
  inputTokens: 23_142,
  outputTokens: 46,
  totalTokens: 23_188,
};

/** The last `usage_update` of that same real turn. */
const REAL_USAGE_UPDATE = {
  sessionUpdate: "usage_update",
  size: 262_144,
  used: 11_611,
  _meta: {
    "poolside/cachedReadTokens": 11_568,
    "poolside/cachedWriteTokens": 0,
    "poolside/inputTokens": 23_142,
    "poolside/outputTokens": 46,
  },
};

/**
 * A script whose first step streams immediately (`delayMs: 0`, so a real
 * chunk is proven to arrive) and whose second falls back to a long
 * script-level delay — interruptible by `session/cancel` — so the turn
 * stays open long enough for steer()/interrupt() to land instead of
 * finishing on its own. Mirrors `ClaudeCodeBackend`'s conformance factory,
 * which holds its stubbed run open the same way.
 */
const HOLD_OPEN_SCRIPT = {
  steps: [
    {
      kind: "update",
      update: agentMessageChunk("hello from pool"),
      delayMs: 0,
    },
    { kind: "update", update: REAL_USAGE_UPDATE, delayMs: 0 },
    { kind: "update", update: agentMessageChunk(" more") },
  ],
  stepDelayMs: 10_000,
  stopReason: "end_turn",
  usage: REAL_USAGE,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordFilePath(): string {
  return join(
    tmpdir(),
    `pool-record-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
}

interface RecordedEntry {
  method: string;
  params?: unknown;
}

/** The JSON lines `POOL_STUB_RECORD_FILE` collected for one turn. */
function recorded(path: string): RecordedEntry[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEntry);
}

/**
 * Runs a turn to completion — the CONTRACT gates `result` on `chunks` being
 * fully consumed, so a test that only wants the recorded wire traffic still
 * has to drain both.
 */
async function drain(handle: {
  chunks: AsyncIterable<unknown>;
  result: Promise<unknown>;
}): Promise<void> {
  for await (const _chunk of handle.chunks) {
    // Discarded: these tests assert on what went out, not what came back.
  }
  await handle.result;
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

describe("PoolsideBackend", () => {
  test("capabilities() is exactly what Poolside can do, no more", () => {
    expect(new PoolsideBackend().capabilities()).toEqual({
      id: "poolside",
      resume: true,
      steering: "restart",
      // Genuinely true: an stdio MCP server passed to a turn really is
      // spawned and handshaken. This is the field OpenFX lied about.
      mcp: true,
      // False on purpose: `thought_level` exists but has two positions
      // against Paco's five, and this boolean cannot say so.
      effort: false,
      subagents: true,
      // False, and measured on BOTH shipped models rather than inferred:
      // `promptCapabilities: {image: true}` in the handshake is the ACP
      // transport talking, not the model. An inline image block is dropped
      // in silence and `Read` on a staged PNG fails with "the configured
      // model does not support image inputs". See backend.ts.
      images: false,
      compaction: false,
      customAgents: false,
      structuredOutput: false,
      models: ["poolside/laguna-s-2.1", "poolside/laguna-xs-2.1"],
    });
  });

  test("a deployment with its own catalog can override the model list", () => {
    expect(
      new PoolsideBackend({ models: ["local/whatever"] }).capabilities().models,
    ).toEqual(["local/whatever"]);
  });

  test("a completed turn streams chunks, real usage, and the session id as resumeToken", async () => {
    const backend = new PoolsideBackend(
      stubConfig({
        steps: [
          { kind: "update", update: agentMessageChunk("hello from stub") },
          { kind: "update", update: REAL_USAGE_UPDATE },
        ],
        stopReason: "end_turn",
        usage: REAL_USAGE,
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
    // Not OpenFX's zeros — these are the numbers the CLI actually reports.
    expect(result.usage).toEqual({
      inputTokens: 23_142,
      outputTokens: 46,
      cachedInputTokens: 11_568,
      cacheCreationInputTokens: 0,
      models: {},
    });
    // No cost anywhere on the wire.
    expect(result.costUsd).toBeUndefined();
    expect(typeof result.resumeToken).toBe("string");
    expect((result.resumeToken ?? "").length).toBeGreaterThan(0);
  });

  test("poolside/task_outcome success:false makes the turn an error", async () => {
    const backend = new PoolsideBackend(
      stubConfig({
        steps: [{ kind: "update", update: agentMessageChunk("gave up") }],
        stopReason: "end_turn",
        taskOutcome: { success: false },
      }),
    );
    const handle = backend.startTurn(turnContext());
    for await (const _chunk of handle.chunks) {
      // drained
    }
    const result = await handle.result;
    // The stop reason is a perfectly ordinary `end_turn`; only the outcome
    // meta says the task failed.
    expect(result.finishReason).toBe("stop");
    expect(result.isError).toBe(true);
  });

  test("result stays pending until chunks are fully drained, even on a fast script", async () => {
    // No hold-open here on purpose: the stubbed turn finishes essentially
    // immediately. `chunks` is not touched until well after that — proving
    // `result` doesn't settle just because the transport did.
    const backend = new PoolsideBackend(
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

    await sleep(300);
    expect(settled).toBe(false);

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    await sleep(0);
    expect(settled).toBe(true);

    expect(
      chunks.some((c) => c.type === "text-delta" && c.delta === "fast"),
    ).toBe(true);
  });

  test("interrupt() rejects result with AbortError despite Poolside reporting end_turn", async () => {
    // The point of this case: the stub answers a cancelled prompt with
    // `stopReason: "end_turn"` exactly as the real CLI does. A backend that
    // trusted the wire would report a clean completion here.
    const backend = new PoolsideBackend(stubConfig(HOLD_OPEN_SCRIPT));
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

  test("steer(text) resolves steered, and still accounts the tokens the turn burned", async () => {
    const backend = new PoolsideBackend(stubConfig(HOLD_OPEN_SCRIPT));
    const handle = backend.startTurn(turnContext());

    const iterator = handle.chunks[Symbol.asyncIterator]();
    // Pull far enough to have seen the scripted usage_update.
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
    // A cancelled `session/prompt` carries NO usage, so this can only have
    // come from the streamed usage_update — without that fallback a steered
    // turn's tokens would vanish from the session log.
    expect(result.usage.inputTokens).toBe(23_142);
    expect(result.usage.outputTokens).toBe(46);
  });

  test("abandoning chunks rejects result with AbortError and kills the process", async () => {
    const pidFile = join(
      tmpdir(),
      `pool-stub-pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const backend = new PoolsideBackend(
      stubConfig(HOLD_OPEN_SCRIPT, { POOL_STUB_PID_FILE: pidFile }),
    );
    const handle = backend.startTurn(turnContext());

    // Equivalent to `for await (…) { break; }`, written explicitly to avoid
    // an unreachable-loop lint warning.
    const iterator = handle.chunks[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    await expect(handle.result).rejects.toMatchObject({ name: "AbortError" });

    // Proves abandonment reached the transport's kill path, not just the
    // backend's own bookkeeping.
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    expect(await waitUntilDead(pid)).toBe(true);
  });

  test("abandonment calls mapper.finish() so no block is left open", async () => {
    const finishSpy = spyOn(PoolsideChunkMapper.prototype, "finish");
    try {
      const backend = new PoolsideBackend(stubConfig(HOLD_OPEN_SCRIPT));
      const handle = backend.startTurn(turnContext());

      const iterator = handle.chunks[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      await handle.result.catch(() => undefined);

      expect(finishSpy).toHaveBeenCalled();
    } finally {
      finishSpy.mockRestore();
    }
  });

  test("a resumed turn loads the session and does NOT re-emit the replayed history", async () => {
    // `session/load` replays the whole conversation as session/update
    // notifications before it answers. Re-emitting those would duplicate an
    // entire transcript into the chat every time a chat resumes.
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        {
          replay: [
            {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "an earlier question" },
            },
            agentMessageChunk("an earlier answer"),
          ],
          steps: [
            { kind: "update", update: agentMessageChunk("the new answer") },
          ],
          stopReason: "end_turn",
        },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );

    const handle = backend.startTurn(
      turnContext({ resumeToken: "session-from-a-previous-process" }),
    );
    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    const result = await handle.result;

    const deltas = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta);
    expect(deltas).toEqual(["the new answer"]);
    expect(deltas).not.toContain("an earlier answer");

    const entries = recorded(recordFile);
    expect(
      entries.find((e) => e.method === "session/load")?.params,
    ).toMatchObject({
      sessionId: "session-from-a-previous-process",
      cwd: process.cwd(),
    });
    // No session/new on a resumed turn, and the token round-trips.
    expect(entries.some((e) => e.method === "session/new")).toBe(false);
    expect(result.resumeToken).toBe("session-from-a-previous-process");
  });

  test("model and thought level ride in as early config options on a new session", async () => {
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );

    await drain(
      backend.startTurn(
        turnContext({
          backendOptions: {
            model: "poolside/laguna-xs-2.1",
            thoughtLevel: "none",
            agentMode: "plan",
          } satisfies PoolsideBackendOptions,
        }),
      ),
    );

    const newSession = recorded(recordFile).find(
      (e) => e.method === "session/new",
    );
    // `configId`, not `id`: the live CLI rejects `{id, value}` with
    // "unknown config option".
    expect(
      (newSession?.params as { _meta?: Record<string, unknown> } | undefined)
        ?._meta,
    ).toEqual({
      "poolside/early_session_config_options": [
        { configId: "agent_mode", value: "plan" },
        { configId: "thought_level", value: "none" },
        { configId: "model", value: "poolside/laguna-xs-2.1" },
      ],
    });
  });

  test("a resumed turn applies the same options via session/set_config_option", async () => {
    // session/load takes no early options, so the resumed path has to set
    // them one at a time or a resumed chat would silently drop back to the
    // session's stored model.
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );

    await drain(
      backend.startTurn(
        turnContext({
          resumeToken: "prior-session",
          backendOptions: {
            model: "poolside/laguna-xs-2.1",
          } satisfies PoolsideBackendOptions,
        }),
      ),
    );

    expect(
      recorded(recordFile)
        .filter((e) => e.method === "session/set_config_option")
        .map((e) => e.params),
    ).toEqual([
      {
        sessionId: "prior-session",
        configId: "model",
        value: "poolside/laguna-xs-2.1",
      },
    ]);
  });

  test("a rejected config option fails the turn instead of being swallowed", async () => {
    // A model choice that silently does nothing is worse than one that
    // says so: the user is billed for, and reasons with, a model they did
    // not pick. The stub rejects every set_config_option here, standing in
    // for an option or value the CLI does not know.
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_REJECT_CONFIG: "1" },
      ),
    );
    const handle = backend.startTurn(
      turnContext({
        resumeToken: "prior-session",
        backendOptions: {
          model: "poolside/laguna-xs-2.1",
        } satisfies PoolsideBackendOptions,
      }),
    );

    await expect(drain(handle)).rejects.toMatchObject({ name: "AcpError" });
  });

  test("nothing sets Poolside's own approval mode unless a turn asks for it", async () => {
    // `mode` left at "default" is what keeps every tool call arriving as a
    // session/request_permission for Paco's approval policy to answer;
    // "always-allow" would bypass that policy inside the agent.
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );
    await drain(backend.startTurn(turnContext()));

    const newSession = recorded(recordFile).find(
      (e) => e.method === "session/new",
    );
    expect(
      (newSession?.params as { _meta?: unknown } | undefined)?._meta,
    ).toBeUndefined();
  });

  test("systemContext leads the prompt, ahead of the user text, with images after", async () => {
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );

    await drain(
      backend.startTurn(
        turnContext({
          prompt: "build the thing",
          backendOptions: {
            systemContext: "## Running the app\ndocker exec -d …",
            images: [{ mimeType: "image/png", data: "aGk=" }],
          } satisfies PoolsideBackendOptions,
        }),
      ),
    );

    const prompt = recorded(recordFile).find(
      (e) => e.method === "session/prompt",
    );
    expect(
      (prompt?.params as { prompt?: unknown } | undefined)?.prompt,
    ).toEqual([
      { type: "text", text: "## Running the app\ndocker exec -d …" },
      { type: "text", text: "build the thing" },
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
  });

  test("mcpServers reach session/new with env as the wire's {name,value} array", async () => {
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
    );

    await drain(
      backend.startTurn(
        turnContext({
          backendOptions: {
            mcpServers: [
              {
                name: "paco-plugins",
                // Not required to be absolute, unlike OpenFX.
                command: "node",
                args: ["/opt/paco/plugin-mcp-server.ts"],
                env: { PACO_INTERNAL_TOKEN: "secret" },
              },
            ],
          } satisfies PoolsideBackendOptions,
        }),
      ),
    );

    const newSession = recorded(recordFile).find(
      (e) => e.method === "session/new",
    );
    expect(newSession?.params).toEqual({
      cwd: process.cwd(),
      mcpServers: [
        {
          name: "paco-plugins",
          command: "node",
          args: ["/opt/paco/plugin-mcp-server.ts"],
          // The Record the caller gave, converted to what the CLI takes.
          env: [{ name: "PACO_INTERNAL_TOKEN", value: "secret" }],
        },
      ],
    });
  });

  test("per-turn env layers over the instance-wide credentials", async () => {
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend(
      stubConfig(
        { steps: [], stopReason: "end_turn" },
        {
          POOL_STUB_RECORD_FILE: recordFile,
          POOLSIDE_API_KEY: "sk-instance",
        },
      ),
    );

    await drain(
      backend.startTurn(
        turnContext({
          backendOptions: {
            env: { GH_TOKEN: "gh-abc", GITHUB_TOKEN: "gh-abc" },
          } satisfies PoolsideBackendOptions,
        }),
      ),
    );

    const spawn = recorded(recordFile).find((e) => e.method === "__spawn");
    const env = (spawn as { env?: Record<string, string> } | undefined)?.env;
    expect(env?.GH_TOKEN).toBe("gh-abc");
    expect(env?.GITHUB_TOKEN).toBe("gh-abc");
    // The instance credential survives the per-turn layer.
    expect(env?.POOLSIDE_API_KEY).toBe("sk-instance");
  });

  test("sandbox and settings become real `pool acp` flags", async () => {
    const recordFile = recordFilePath();
    const backend = new PoolsideBackend({
      ...stubConfig(
        { steps: [], stopReason: "end_turn" },
        { POOL_STUB_RECORD_FILE: recordFile },
      ),
      sandbox: "required",
      settings: "pool:\n  api_url: https://example.invalid\n",
    });

    await drain(backend.startTurn(turnContext()));

    const spawn = recorded(recordFile).find((e) => e.method === "__spawn");
    expect((spawn as { argv?: string[] } | undefined)?.argv).toEqual([
      "acp",
      "--sandbox",
      "required",
      "--settings",
      "pool:\n  api_url: https://example.invalid\n",
    ]);
  });

  test("a permission request round-trips through onApprovalRequest", async () => {
    const received: PermissionRequestParams[] = [];
    const script = {
      steps: [
        {
          kind: "permission",
          permission: {
            toolCall: {
              toolCallId: "t1",
              title: "Run echo command: `echo hello-paco`",
              kind: "execute",
              status: "pending",
              // Poolside really sends the arguments, so the approval policy
              // gets something to decide on.
              rawInput: { cmd: "echo hello-paco" },
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

    const backend = new PoolsideBackend(stubConfig(script));
    const handle = backend.startTurn(
      turnContext({
        backendOptions: { onApprovalRequest } satisfies PoolsideBackendOptions,
      }),
    );

    const chunks = [];
    for await (const chunk of handle.chunks) {
      chunks.push(chunk);
    }
    const result = await handle.result;

    expect(received).toHaveLength(1);
    expect(received[0]?.toolCall.toolCallId).toBe("t1");
    expect(received[0]?.toolCall.rawInput).toEqual({ cmd: "echo hello-paco" });
    expect(received[0]?.options.map((o) => o.optionId)).toEqual([
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

  test("with no handler configured, permissions are denied and the turn still completes", async () => {
    const backend = new PoolsideBackend(
      stubConfig({
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
                {
                  optionId: "reject_once",
                  name: "Reject",
                  kind: "reject_once",
                },
              ],
            },
          },
          { kind: "update", update: agentMessageChunk("after permission") },
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

    expect(result.finishReason).toBe("stop");
    expect(
      chunks.some(
        (c) => c.type === "text-delta" && c.delta === "after permission",
      ),
    ).toBe(true);
  });

  test("denyPermissionHandler picks reject_once when offered, else cancels", () => {
    const toolCall = {
      toolCallId: "t1",
      title: "x",
      kind: "edit",
      status: "pending" as const,
      rawInput: undefined,
    };
    expect(
      denyPermissionHandler({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });

    expect(
      denyPermissionHandler({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("allowAllPermissionHandler prefers allow_always, falls back to allow_once", () => {
    const toolCall = {
      toolCallId: "t1",
      title: "x",
      kind: "edit",
      status: "pending" as const,
      rawInput: undefined,
    };

    // Both offered: the durable one, since the session is already
    // allow-everything and re-asking for the same tool buys nothing.
    expect(
      allowAllPermissionHandler({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "allow_always", name: "Always", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow_always" } });

    expect(
      allowAllPermissionHandler({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });

    // Nothing allow-shaped on offer: it must never fall through to a
    // rejection, which would contradict the configured mode.
    expect(
      allowAllPermissionHandler({
        sessionId: "s",
        toolCall,
        options: [
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      }),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("PoolsideBackend conformance", () => {
  runBackendConformance("PoolsideBackend", () => ({
    backend: new PoolsideBackend(stubConfig(HOLD_OPEN_SCRIPT)),
    turnContext: turnContext({ prompt: "conformance prompt" }),
  }));
});
