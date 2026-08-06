import { describe, expect, mock, test } from "bun:test";
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

mock.module("@paco/claude-code", () => ({
  DEFAULT_AGENTS: {},
  buildApprovalSettings: () => ({ hooks: {} }),
  streamClaudeAgent: () => ({
    chunks: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
    result: Promise.resolve(result),
    sessionId: Promise.resolve("claude-session-1"),
  }),
  toRunUsage: () => ({
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    models: {},
  }),
  toFinishReason: () => "stop" as const,
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
});
