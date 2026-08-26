import { describe, expect, mock, test } from "bun:test";
import { FakeBackend, zeroUsage } from "@paco/agent-backend";
import type {
  AgentBackend,
  BackendCapabilities,
  TurnContext,
  TurnHandle,
} from "@paco/agent-backend";
import type { UIMessage, UIMessageChunk } from "ai";
mock.module("server-only", () => ({}));

/**
 * Assistant messages are persisted with an upsert keyed on the message id, so an
 * id that comes back empty makes every turn in a chat overwrite the same row.
 * The id is not in the chunks this function consumes — the workflow writes the
 * stream's `start` chunk around it — so `runAgentTurn` has to stamp it on.
 */

const chunks: UIMessageChunk[] = [
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "done" },
  { type: "text-end", id: "text-1" },
];

const result = {
  type: "result" as const,
  subtype: "success" as const,
  session_id: "claude-session-1",
  is_error: false,
  total_cost_usd: 0.01,
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

/**
 * `runAgentTurn` now talks to `@paco/claude-code` only through
 * `ClaudeCodeBackend` (the default when no `backend` is passed in). The
 * default-path tests below don't exercise `ClaudeCodeBackend` itself — that's
 * covered by `packages/claude-code/backend.test.ts` — they exercise
 * `runAgentTurn`'s wiring and its mapping of `TurnResult` back onto
 * `AgentStepResult`. So the fake here plays the role of `ClaudeCodeBackend`,
 * returning a `TurnHandle`/`TurnResult` directly instead of the CLI's raw
 * result shape that the real backend would translate.
 */
mock.module("@paco/claude-code", () => ({
  DEFAULT_AGENTS: {},
  buildApprovalSettings: () => ({ hooks: {} }),
  ClaudeCodeBackend: class {
    // `runAgentTurn` now resolves its backend through `backend-factory.ts`,
    // which switches on `capabilities().id` to decide which options shape to
    // build — the default-path tests below exercise that switch too, not
    // just `startTurn`, so this stub needs a real-shaped `capabilities()`.
    capabilities() {
      return {
        id: "claude-code" as const,
        resume: true,
        steering: "restart" as const,
        mcp: true,
        effort: true,
        subagents: true,
      };
    }
    startTurn() {
      return {
        chunks: (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
        result: Promise.resolve({
          finishReason: "stop" as const,
          isError: result.is_error,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            models: {},
          },
          costUsd: result.total_cost_usd,
          resumeToken: result.session_id,
        }),
        steer: () => Promise.resolve(),
        interrupt: () => {
          // no-op: not exercised by the default-path tests
        },
      };
    }
  },
}));

mock.module("@paco/sandbox", () => ({
  workspaceRoot: () => "/tmp/paco-workspaces",
  chatWorktreePath: (chatId: string) => `chats/${chatId}`,
  repoDir: (root: string) => `${root}/repo`,
}));

const modulePromise = import("./run-step");

function makeOptions() {
  return {
    sandbox: {
      state: { hostWorkspace: "/tmp/paco-workspaces/session_x" },
      environmentDetails: "",
      currentBranch: "main",
    },
  } as never;
}

/** Same fixture as `makeOptions`, plus every field that flows into `backendOptions`. */
function makeStructuredOutputOptions() {
  return {
    sandbox: {
      state: { hostWorkspace: "/tmp/paco-workspaces/session_x" },
      environmentDetails: "",
      currentBranch: "main",
    },
    model: { id: "sonnet", effort: "high" },
    agents: { explorer: { description: "explores the repo" } },
    structuredOutput: { jsonSchema: { type: "object", properties: {} } },
    tools: ["Read", "Grep", "Glob", "Bash"],
    disallowedTools: ["Write", "Edit", "NotebookEdit"],
    mcpServers: {
      "paco-plugins": {
        command: "/usr/bin/node",
        args: ["scripts/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    },
  } as never;
}

/**
 * The fixture for the Poolside parity tests: every field that used to be
 * built and then dropped on the floor whenever a chat was switched off
 * Claude Code.
 *
 * `model: { id: "opus" }` is a Claude tier alias on purpose — Poolside
 * declares its own ids, so this fixture is what proves the alias is filtered
 * out rather than handed to a binary that has never heard of it. The
 * companion fixture below supplies an id Poolside really accepts.
 */
function makePoolsideOptions() {
  return {
    sandbox: {
      state: { hostWorkspace: "/tmp/paco-workspaces/session_x" },
      environmentDetails: "Container: paco-sandbox-1",
      currentBranch: "chat/abc",
    },
    model: { id: "opus", effort: "high" },
    customInstructions: "Always run the linter.",
    memorySection: "## Memory\n\n- The user prefers pnpm.",
    mcpServers: {
      "paco-plugins": {
        command: "/usr/bin/node",
        args: ["/opt/paco/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    },
  } as never;
}

interface SpyBackend extends AgentBackend {
  lastCtx?: TurnContext;
}

/**
 * A spy reporting Poolside's real capability set — copied from
 * `PoolsideBackend.capabilities()`, including the fields that say what it
 * cannot carry, which is what the parity tests below turn on.
 *
 * `models` is a real list rather than the empty array the previous ACP
 * backend reported: Poolside accepts its own model ids over ACP's `model`
 * config option, so `resolveModelId` has something to let through as well as
 * something to filter out.
 */
const POOLSIDE_MODELS = [
  "poolside/laguna-s-2.1",
  "poolside/laguna-xs-2.1",
] as const;

function createPoolsideSpyBackend(): SpyBackend {
  const spy: SpyBackend = {
    lastCtx: undefined,
    capabilities(): BackendCapabilities {
      return {
        id: "poolside",
        resume: true,
        steering: "restart",
        mcp: true,
        effort: false,
        subagents: true,
        customAgents: false,
        structuredOutput: false,
        models: POOLSIDE_MODELS,
      };
    },
    startTurn(ctx: TurnContext): TurnHandle {
      spy.lastCtx = ctx;
      return {
        chunks: (async function* () {
          // no chunks: this backend only exists to record its TurnContext
        })(),
        result: Promise.resolve({
          finishReason: "stop",
          isError: false,
          usage: zeroUsage(),
          resumeToken: "poolside-session-1",
        }),
        steer: () => Promise.resolve(),
        interrupt: () => {
          // no-op: not exercised here
        },
      };
    },
  };
  return spy;
}

/**
 * Records the `TurnContext` it was started with, so a test can assert exactly
 * what `runAgentTurn` forwards to a backend — the thing missing before this
 * test, per review: a dropped option (e.g. `model`) would otherwise go
 * unnoticed since no test inspected the call args.
 */
function createSpyBackend(): SpyBackend {
  const spy: SpyBackend = {
    lastCtx: undefined,
    capabilities(): BackendCapabilities {
      return {
        id: "spy",
        resume: true,
        steering: "restart",
        mcp: false,
        effort: false,
        subagents: false,
      };
    },
    startTurn(ctx: TurnContext): TurnHandle {
      spy.lastCtx = ctx;
      return {
        chunks: (async function* () {
          // no chunks: this backend only exists to record its TurnContext
        })(),
        result: Promise.resolve({
          finishReason: "stop",
          isError: false,
          usage: zeroUsage(),
          resumeToken: "spy-session-1",
        }),
        steer: () => Promise.resolve(),
        interrupt: () => {
          // no-op: not exercised here
        },
      };
    },
  };
  return spy;
}

describe("runAgentTurn", () => {
  test("stamps the caller's message id onto the response", async () => {
    const { runAgentTurn } = await modulePromise;

    const step = await runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      onChunk: async () => {
        // no-op: the test only inspects the reconstructed message
      },
    });

    expect(step.responseMessage?.id).toBe("assistant-42");
  });

  test("returns the session id so the next turn can resume", async () => {
    const { runAgentTurn } = await modulePromise;

    const step = await runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      onChunk: async () => {
        // no-op
      },
    });

    expect(step.claudeSessionId).toBe("claude-session-1");
    expect(step.finishReason).toBe("stop");
  });

  test("drives a provided AgentBackend", async () => {
    const { runAgentTurn } = await modulePromise;

    const fakeChunks: UIMessageChunk[] = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "from the fake backend" },
      { type: "text-end", id: "text-1" },
    ];
    const backend = new FakeBackend({ script: fakeChunks });

    const seen: UIMessageChunk[] = [];

    const step = await runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      onChunk: async (chunk) => {
        seen.push(chunk);
      },
    });

    expect(seen).toEqual(fakeChunks);

    const textPart = step.responseMessage?.parts.find(
      (part): part is { type: "text"; text: string } => part.type === "text",
    );
    expect(textPart?.text).toContain("from the fake backend");

    expect(step.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: {},
    });
    expect(step.claudeSessionId).toBe("fake-session-1");
  });

  test("forwards the resolved cwd, prompt, and backend options to startTurn", async () => {
    const { runAgentTurn } = await modulePromise;

    const backend = createSpyBackend();
    const abortController = new AbortController();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: makeStructuredOutputOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      claudeSessionId: "prior-session-99",
      maxTurns: 7,
      githubToken: "gh-token-abc",
      chatId: "chat-123",
      approval: {
        url: "https://example.test/approve",
        token: "approval-token-xyz",
      },
      abortSignal: abortController.signal,
      onChunk: async () => {
        // no-op: this test only inspects the recorded TurnContext
      },
    });

    const ctx = backend.lastCtx;
    expect(ctx?.cwd).toBe("/tmp/paco-workspaces/session_x");
    expect(ctx?.prompt).toBe("build the thing");
    expect(ctx?.resumeToken).toBe("prior-session-99");
    expect(ctx?.abortSignal).toBe(abortController.signal);

    const backendOptions = ctx?.backendOptions as Record<string, unknown>;
    expect(backendOptions.model).toBe("sonnet");
    expect(backendOptions.effort).toBe("high");
    expect(backendOptions.agents).toEqual({
      explorer: { description: "explores the repo" },
    });
    expect(backendOptions.permissionMode).toBe("bypassPermissions");
    expect(backendOptions.maxTurns).toBe(7);
    expect(backendOptions.includePartialMessages).toBe(true);
    expect(backendOptions.settings).toBeDefined();
    expect(backendOptions.jsonSchema).toEqual({
      type: "object",
      properties: {},
    });
    expect(backendOptions.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(backendOptions.disallowedTools).toEqual([
      "Write",
      "Edit",
      "NotebookEdit",
    ]);
    expect(backendOptions.mcpServers).toEqual({
      "paco-plugins": {
        command: "/usr/bin/node",
        args: ["scripts/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    });

    const env = backendOptions.env as Record<string, string>;
    expect(env.GH_TOKEN).toBe("gh-token-abc");
    expect(env.GITHUB_TOKEN).toBe("gh-token-abc");
    expect(env.PACO_APPROVAL_URL).toBe("https://example.test/approve");
    expect(env.PACO_APPROVAL_TOKEN).toBe("approval-token-xyz");
    expect(env.PACO_APPROVAL_CHAT_ID).toBe("chat-123");
  });

  test("builds PoolsideBackendOptions, not Claude's shape, when the resolved backend reports id 'poolside'", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      chatId: "chat-123",
      approval: {
        url: "https://example.test/approve",
        token: "approval-token-xyz",
      },
      onChunk: async () => {
        // no-op: this test only inspects the recorded TurnContext
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    // Claude-only fields must not leak into a Poolside turn's options.
    expect(backendOptions.permissionMode).toBeUndefined();
    expect(backendOptions.agents).toBeUndefined();
    expect(backendOptions.settings).toBeUndefined();
    expect(backendOptions.sessionId).toBeUndefined();
    // The approval handler is wired in-process (see poolside-approval.ts),
    // not via PACO_APPROVAL_URL/env vars.
    expect(typeof backendOptions.onApprovalRequest).toBe("function");
    expect(backendOptions.env).toBeUndefined();
  });

  /**
   * THE regression this rewrite exists to prevent, in one assertion.
   *
   * `appendSystemPrompt` and `mcpServers` were both built unconditionally
   * and then spread in only on the `claude-code` branch, so flipping a chat
   * to the second backend silently dropped memory, skills, project
   * instructions, the environment details, the "## Running the app" briefing
   * — the last of which is why an agent starts its dev server on the host
   * and the preview comes up blank — AND every MCP server, while the
   * backend's own `capabilities()` went on claiming `mcp: true`.
   *
   * Deliberately asserted together: a turn is only correctly wired if BOTH
   * arrive, and splitting them into two tests is how one of them gets
   * quietly deleted.
   */
  test("a Poolside turn RECEIVES the system context and the mcpServers", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: makePoolsideOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      onChunk: async () => {
        // no-op: this test only inspects the recorded TurnContext
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;

    const systemContext = backendOptions.systemContext as string;
    expect(systemContext).toContain("The user prefers pnpm.");
    expect(systemContext).toContain("Always run the linter.");
    expect(systemContext).toContain("Container: paco-sandbox-1");
    expect(systemContext).toContain("## Running the app");

    // An array, each entry carrying its own `name` — ACP's `session/new`
    // shape, not the Claude Code CLI's name-keyed record.
    expect(backendOptions.mcpServers).toEqual([
      {
        name: "paco-plugins",
        command: "/usr/bin/node",
        args: ["/opt/paco/plugin-mcp-server.ts"],
        env: { PACO_INTERNAL_TOKEN: "secret" },
      },
    ]);
  });

  /**
   * The previous ACP backend rejected a relative `command` outright, failing
   * the whole session, so `run-step` dropped such a server with a warning.
   * Poolside resolves a bare command on `PATH`, so nothing is dropped — a
   * filter kept "just in case" would be the silent-drop bug all over again,
   * in the one place this file is meant to have eliminated it.
   */
  test("a Poolside turn keeps an MCP server whose command is not an absolute path", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: {
        sandbox: {
          state: { hostWorkspace: "/tmp/paco-workspaces/session_x" },
          environmentDetails: "",
          currentBranch: "main",
        },
        mcpServers: {
          relative: { command: "node", args: ["server.ts"], env: {} },
        },
      } as never,
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      onChunk: async () => {
        // no-op
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    expect(backendOptions.mcpServers).toEqual([
      { name: "relative", command: "node", args: ["server.ts"], env: {} },
    ]);
  });

  test("a Poolside turn carries the user's GitHub token, so `gh` is not the host keyring's account", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "open a pull request",
      options: makePoolsideOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      githubToken: "gh-token-abc",
      onChunk: async () => {
        // no-op
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    const env = backendOptions.env as Record<string, string>;
    expect(env.GH_TOKEN).toBe("gh-token-abc");
    expect(env.GITHUB_TOKEN).toBe("gh-token-abc");
  });

  test("a backend that names model ids is not handed the picker's Claude tier alias", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      // The fixture's model is `opus`.
      options: makePoolsideOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      onChunk: async () => {
        // no-op
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    // "opus" means nothing to Poolside; it resolves its own default instead.
    expect(backendOptions.model).toBeUndefined();
  });

  /**
   * The other half of the same rule, and the half the previous ACP backend
   * could never exercise because it accepted no ids at all: a model the
   * backend DOES declare is forwarded rather than filtered, so the picker is
   * not decorative.
   */
  test("a model id the backend declares is forwarded", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: {
        sandbox: {
          state: { hostWorkspace: "/tmp/paco-workspaces/session_x" },
          environmentDetails: "",
          currentBranch: "main",
        },
        model: { id: "poolside/laguna-xs-2.1" },
      } as never,
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      onChunk: async () => {
        // no-op
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    expect(backendOptions.model).toBe("poolside/laguna-xs-2.1");
  });

  /**
   * `capabilities().effort` is `false` for Poolside, so the picker's effort
   * is not forwarded. Poolside does have a reasoning knob, but it holds two
   * values against Paco's five — see `poolsideThoughtLevel`'s doc in the
   * package. The fixture sets `effort: "high"`; nothing should carry it.
   */
  test("a Poolside turn is not handed Paco's five-level effort setting", async () => {
    const { runAgentTurn } = await modulePromise;

    const spy = createPoolsideSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "build the thing",
      options: makePoolsideOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend: spy,
      onChunk: async () => {
        // no-op
      },
    });

    const backendOptions = spy.lastCtx?.backendOptions as Record<
      string,
      unknown
    >;
    expect(backendOptions.effort).toBeUndefined();
    expect(backendOptions.thoughtLevel).toBeUndefined();
  });

  test("surfaces a backend's structuredOutput on the step result", async () => {
    const { runAgentTurn } = await modulePromise;

    const backend = new FakeBackend({
      script: [],
      structuredOutput: { tasks: [{ title: "t", goal: "g" }] },
    });

    const step = await runAgentTurn<UIMessage>({
      prompt: "plan the thing",
      options: makeStructuredOutputOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      onChunk: async () => {
        // no-op
      },
    });

    expect(step.structuredOutput).toEqual({
      tasks: [{ title: "t", goal: "g" }],
    });
  });

  test("with no claudeSessionId: mints a fresh sessionId and leaves resumeToken unset", async () => {
    const { runAgentTurn } = await modulePromise;

    const backend = createSpyBackend();

    await runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      onChunk: async () => {
        // no-op
      },
    });

    const ctx = backend.lastCtx;
    expect(ctx?.resumeToken).toBeUndefined();

    const backendOptions = ctx?.backendOptions as Record<string, unknown>;
    expect(backendOptions.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /**
   * Follow-up review of Task 10 (turn steering): steering used to go through
   * the caller's `AbortController`, which the backend can only see as an
   * unexplained interrupt — it never learns *why* the turn stopped, so it
   * can't report a clean `steered` result or the session id needed to
   * resume. `steerController` lets the caller reach the backend's own
   * `steer()` instead, which winds the turn down on purpose.
   */
  test("registers a steer function via steerController, and the result carries `steered` when it is called", async () => {
    const { runAgentTurn } = await modulePromise;

    // `holdOpen` keeps the turn running after its scripted chunks, so there
    // is time to call the registered steer function before the turn would
    // otherwise finish on its own.
    const backend = new FakeBackend({ script: chunks, holdOpen: true });

    let registeredSteer: ((text: string) => Promise<void>) | undefined;

    const stepPromise = runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      steerController: {
        onSteer: (steer) => {
          registeredSteer = steer;
        },
      },
      onChunk: async () => {
        // no-op
      },
    });

    // `startTurn` and the `onSteer` registration both happen synchronously
    // inside `runAgentTurn`, before its first `await` — so this is already
    // set by the time the call above returns a promise. Awaiting a resolved
    // promise first keeps the assertion robust even if that ever changes.
    await Promise.resolve();
    expect(registeredSteer).toBeDefined();

    await registeredSteer?.("actually, do this instead");

    const step = await stepPromise;
    expect(step.steered).toEqual({ text: "actually, do this instead" });
    expect(step.finishReason).toBe("stop");
    expect(step.isError).toBe(false);
  });

  test("never registers a steer function when no steerController is given", async () => {
    const { runAgentTurn } = await modulePromise;

    const backend = new FakeBackend({ script: chunks });

    // Exercises the plain default path (no steerController at all) to prove
    // `runAgentTurn` doesn't require one — the option is additive.
    const step = await runAgentTurn<UIMessage>({
      prompt: "hi",
      options: makeOptions(),
      messageId: "assistant-42",
      originalMessages: [],
      backend,
      onChunk: async () => {
        // no-op
      },
    });

    expect(step.steered).toBeUndefined();
  });
});
