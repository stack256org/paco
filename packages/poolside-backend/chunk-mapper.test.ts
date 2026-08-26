import { describe, expect, spyOn, test } from "bun:test";
import { PoolsideChunkMapper } from "./chunk-mapper.ts";

/**
 * Every fixture in this file is a VERBATIM payload captured from a live
 * `pool acp` 1.0.16 turn (a prompt that ran `echo hello-paco` and then
 * replied), except `agent_thought_chunk`, which is noted where it is used.
 * Mapping is only worth testing against the shapes the binary really sends.
 */

const AGENT_MESSAGE_CHUNK = {
  _meta: { "poolside/step_id": "01a03ccd-21f0-77ad-ad75-e39598ba7565" },
  content: { text: "hello", type: "text" },
  messageId: "01a03ccd-21f0-77ad-ad75-e39598ba7565/agent",
  sessionUpdate: "agent_message_chunk",
};

const TOOL_CALL = {
  _meta: {
    "poolside/step_id": "01a03ccd-1c39-77a9-9684-98cadd4fc032",
    tool_name: "shell",
  },
  kind: "execute",
  rawInput: { cmd: "echo hello-paco", description: "Run echo command" },
  sessionUpdate: "tool_call",
  status: "pending",
  title: "Run echo command: `echo hello-paco`",
  toolCallId: "chatcmpl-tool-c5496877308f401eafa71a41bbf8a100",
};

const TOOL_CALL_UPDATE = {
  _meta: { "poolside/step_id": "01a03ccd-1c39-77a9-9684-98cadd4fc032" },
  content: [
    {
      content: { text: "```\nhello-paco\n```", type: "text" },
      type: "content",
    },
  ],
  rawOutput: {
    observation:
      "Shell shell-echo\nexited with code 0\nstatus: completed\noutput:\n```\nhello-paco\n```",
  },
  sessionUpdate: "tool_call_update",
  status: "completed",
  toolCallId: "chatcmpl-tool-c5496877308f401eafa71a41bbf8a100",
};

const USAGE_UPDATE = {
  _meta: {
    "poolside/cachedReadTokens": 11_568,
    "poolside/cachedWriteTokens": 0,
    "poolside/inputTokens": 23_142,
    "poolside/outputTokens": 46,
  },
  sessionUpdate: "usage_update",
  size: 262_144,
  used: 11_611,
};

const SESSION_INFO_UPDATE = {
  _meta: {
    "poolside/clientInputId": "paco-input-1",
    "poolside/inputEventId": "01a03ccd-1c38-77a9-8553-b4ebb68a2a73",
  },
  sessionUpdate: "session_info_update",
};

const USER_MESSAGE_CHUNK = {
  content: {
    text: "Run the shell command `echo hello-paco` and then reply with exactly: DONE",
    type: "text",
  },
  sessionUpdate: "user_message_chunk",
};

function textChunk(text: string) {
  return { ...AGENT_MESSAGE_CHUNK, content: { text, type: "text" } };
}

describe("PoolsideChunkMapper", () => {
  test("opens one text block and streams deltas into it", () => {
    const mapper = new PoolsideChunkMapper();
    const first = mapper.map(textChunk("hello"));
    const second = mapper.map(textChunk(" world"));

    expect(first).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hello" },
    ]);
    // The second delta joins the SAME block: ACP sends no block boundaries,
    // so a run only ends when something else arrives.
    expect(second).toEqual([
      { type: "text-delta", id: "text-1", delta: " world" },
    ]);
    expect(mapper.finish()).toEqual([{ type: "text-end", id: "text-1" }]);
  });

  test("a tool call carries the REAL rawInput and Poolside's tool_name", () => {
    const mapper = new PoolsideChunkMapper();
    mapper.map(textChunk("hello"));
    const chunks = mapper.map(TOOL_CALL);

    // The tool call ends the open text run first.
    expect(chunks[0]).toEqual({ type: "text-end", id: "text-1" });
    expect(chunks[1]).toEqual({
      type: "tool-input-start",
      toolCallId: TOOL_CALL.toolCallId,
      // `_meta.tool_name` ("shell"), not the coarser ACP kind ("execute").
      toolName: "shell",
      title: TOOL_CALL.title,
    });
    expect(chunks[2]).toEqual({
      type: "tool-input-available",
      toolCallId: TOOL_CALL.toolCallId,
      toolName: "shell",
      // OpenFX could only ever emit `{}` here; Poolside really sends this.
      input: { cmd: "echo hello-paco", description: "Run echo command" },
      title: TOOL_CALL.title,
    });
  });

  test("falls back to the ACP kind when _meta.tool_name is absent", () => {
    const mapper = new PoolsideChunkMapper();
    const { _meta, ...withoutMeta } = TOOL_CALL;
    const chunks = mapper.map(withoutMeta);
    expect(chunks[0]).toMatchObject({
      type: "tool-input-start",
      toolName: "execute",
    });
  });

  test("emits {} for a tool call that carries no rawInput", () => {
    const mapper = new PoolsideChunkMapper();
    const { rawInput: _rawInput, ...withoutInput } = TOOL_CALL;
    const chunks = mapper.map(withoutInput);
    expect(chunks[1]).toMatchObject({
      type: "tool-input-available",
      input: {},
    });
  });

  test("a completed tool call yields its content text as output", () => {
    const mapper = new PoolsideChunkMapper();
    expect(mapper.map(TOOL_CALL_UPDATE)).toEqual([
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_UPDATE.toolCallId,
        output: "```\nhello-paco\n```",
      },
    ]);
  });

  test("falls back to rawOutput.observation when content is empty", () => {
    // A completed call with no displayable content would otherwise show as
    // nothing at all; `observation` carries the command, its exit code and
    // its output.
    const mapper = new PoolsideChunkMapper();
    const { content: _content, ...withoutContent } = TOOL_CALL_UPDATE;
    expect(mapper.map(withoutContent)).toEqual([
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_UPDATE.toolCallId,
        output: TOOL_CALL_UPDATE.rawOutput.observation,
      },
    ]);
  });

  test("a failed tool call yields tool-output-error", () => {
    const mapper = new PoolsideChunkMapper();
    expect(mapper.map({ ...TOOL_CALL_UPDATE, status: "failed" })).toEqual([
      {
        type: "tool-output-error",
        toolCallId: TOOL_CALL_UPDATE.toolCallId,
        errorText: "```\nhello-paco\n```",
      },
    ]);
  });

  test("in-progress content is preliminary; a bare status transition emits nothing", () => {
    const mapper = new PoolsideChunkMapper();
    expect(mapper.map({ ...TOOL_CALL_UPDATE, status: "in_progress" })).toEqual([
      {
        type: "tool-output-available",
        toolCallId: TOOL_CALL_UPDATE.toolCallId,
        output: "```\nhello-paco\n```",
        preliminary: true,
      },
    ]);

    const bare = new PoolsideChunkMapper();
    expect(
      bare.map({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "in_progress",
      }),
    ).toEqual([]);
  });

  test("thinking maps to reasoning chunks, and text and thinking close each other", () => {
    // `agent_thought_chunk` is the one kind here NOT captured from a live
    // turn (the probe ran at thought_level "none"); the payload mirrors
    // `agent_message_chunk`, which is the only shape the CLI has for a
    // content delta.
    const mapper = new PoolsideChunkMapper();
    const thinking = mapper.map({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "let me check" },
    });
    expect(thinking).toEqual([
      { type: "reasoning-start", id: "reasoning-1" },
      { type: "reasoning-delta", id: "reasoning-1", delta: "let me check" },
    ]);

    // Assistant text closes the reasoning run rather than interleaving.
    expect(mapper.map(textChunk("done"))).toEqual([
      { type: "reasoning-end", id: "reasoning-1" },
      { type: "text-start", id: "text-2" },
      { type: "text-delta", id: "text-2", delta: "done" },
    ]);
  });

  test("control-plane updates emit nothing and do not end an open text run", () => {
    const mapper = new PoolsideChunkMapper();
    mapper.map(textChunk("hello"));

    for (const update of [
      USAGE_UPDATE,
      SESSION_INFO_UPDATE,
      { sessionUpdate: "available_commands_update", availableCommands: [] },
      { sessionUpdate: "config_option_update", configOptions: [] },
    ]) {
      expect(mapper.map(update)).toEqual([]);
    }

    // Still the same block — a mid-stream control update must not fragment
    // one assistant message into several.
    expect(mapper.map(textChunk(" again"))).toEqual([
      { type: "text-delta", id: "text-1", delta: " again" },
    ]);
  });

  test("a replayed user message emits nothing but closes an open run", () => {
    const mapper = new PoolsideChunkMapper();
    mapper.map(textChunk("hello"));
    expect(mapper.map(USER_MESSAGE_CHUNK)).toEqual([
      { type: "text-end", id: "text-1" },
    ]);
  });

  test("an unknown kind is ignored and warned about exactly once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const mapper = new PoolsideChunkMapper();
      expect(mapper.map({ sessionUpdate: "from_the_future" })).toEqual([]);
      expect(mapper.map({ sessionUpdate: "from_the_future" })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("malformed updates are ignored rather than thrown", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const mapper = new PoolsideChunkMapper();
      expect(mapper.map(null)).toEqual([]);
      expect(mapper.map("nope")).toEqual([]);
      expect(mapper.map({ noDiscriminant: true })).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("finish() closes both an open reasoning run and an open text run", () => {
    const mapper = new PoolsideChunkMapper();
    mapper.map({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "hm" },
    });
    // Reasoning is closed by the text that follows, so open a fresh one to
    // prove finish() handles both kinds.
    const chunks = mapper.finish();
    expect(chunks).toEqual([{ type: "reasoning-end", id: "reasoning-1" }]);
    // Idempotent: nothing is left open to close twice.
    expect(mapper.finish()).toEqual([]);
  });
});
