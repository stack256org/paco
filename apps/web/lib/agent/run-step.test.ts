import { describe, expect, mock, test } from "bun:test";
import { FakeBackend } from "@paco/agent-backend";
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
});
