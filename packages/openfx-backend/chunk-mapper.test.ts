import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AcpChunkMapper } from "./chunk-mapper.ts";

describe("AcpChunkMapper", () => {
  describe("table: one update -> exact chunk sequence (PROTOCOL.md §3)", () => {
    test.each<[string, unknown, UIMessageChunk[]]>([
      [
        "agent_message_chunk -> text-start + text-delta (first chunk of a run)",
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        },
        [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Hello" },
        ],
      ],
      [
        "user_message_chunk -> [] (history replay, not assistant output)",
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hi" },
        },
        [],
      ],
      [
        "tool_call (pending) -> tool-input-start + tool-input-available (no rawInput on the wire)",
        {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Read file",
          kind: "read",
          status: "pending",
        },
        [
          {
            type: "tool-input-start",
            toolCallId: "t1",
            toolName: "read",
            title: "Read file",
          },
          {
            type: "tool-input-available",
            toolCallId: "t1",
            toolName: "read",
            input: {},
            title: "Read file",
          },
        ],
      ],
      [
        "tool_call_update completed with content -> tool-output-available",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "ok" } }],
        },
        [{ type: "tool-output-available", toolCallId: "t1", output: "ok" }],
      ],
      [
        "tool_call_update completed with command_result -> output folds it in",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "exit_code=0" } },
          ],
          command_result: { kind: "foreground", exit_code: 0 },
        },
        [
          {
            type: "tool-output-available",
            toolCallId: "t1",
            output: {
              text: "exit_code=0",
              commandResult: { kind: "foreground", exit_code: 0 },
            },
          },
        ],
      ],
      [
        "tool_call_update completed with no content -> empty-string output",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
        },
        [{ type: "tool-output-available", toolCallId: "t1", output: "" }],
      ],
      [
        "tool_call_update failed with content -> tool-output-error",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "failed",
          content: [
            { type: "content", content: { type: "text", text: "boom" } },
          ],
        },
        [{ type: "tool-output-error", toolCallId: "t1", errorText: "boom" }],
      ],
      [
        "tool_call_update failed with no content -> fallback errorText",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "failed",
        },
        [
          {
            type: "tool-output-error",
            toolCallId: "t1",
            errorText: "Tool call failed",
          },
        ],
      ],
      [
        "tool_call_update in_progress -> [] (no AI SDK tool-part state for it)",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "in_progress",
        },
        [],
      ],
      [
        "available_commands_update -> [] (slash-command catalog, not message content)",
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        [],
      ],
      [
        "session_info_update -> [] (provider-outage recovery state, not usage)",
        {
          sessionUpdate: "session_info_update",
          _meta: { fx: { modelResponseRecovery: null } },
        },
        [],
      ],
    ])("%s", (_label, update, expected) => {
      const mapper = new AcpChunkMapper();
      expect(mapper.map(update)).toEqual(expected);
    });
  });

  describe("unknown / malformed updates", () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      warnSpy = spyOn(console, "warn").mockImplementation(() => {
        // silence output during the test
      });
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test("an unknown sessionUpdate kind maps to [] and warns once", () => {
      const mapper = new AcpChunkMapper();

      expect(mapper.map({ sessionUpdate: "future_kind", foo: "bar" })).toEqual(
        [],
      );
      expect(mapper.map({ sessionUpdate: "future_kind", foo: "baz" })).toEqual(
        [],
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test("warnings are tracked per kind, not globally", () => {
      const mapper = new AcpChunkMapper();

      mapper.map({ sessionUpdate: "kind_a" });
      mapper.map({ sessionUpdate: "kind_a" });
      mapper.map({ sessionUpdate: "kind_b" });

      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    test("a non-object update maps to [] and warns", () => {
      const mapper = new AcpChunkMapper();

      expect(mapper.map(null)).toEqual([]);
      expect(mapper.map("not an update")).toEqual([]);
      expect(mapper.map(42)).toEqual([]);

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("stateful sequences", () => {
    test("multiple deltas in one run share a stable id; a tool call closes the run", () => {
      const mapper = new AcpChunkMapper();

      const first = mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hel" },
      });
      const second = mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "lo" },
      });

      expect(first).toEqual([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Hel" },
      ]);
      expect(second).toEqual([
        { type: "text-delta", id: "text-1", delta: "lo" },
      ]);

      const toolCall = mapper.map({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run command",
        kind: "execute",
        status: "pending",
      });

      expect(toolCall).toEqual([
        { type: "text-end", id: "text-1" },
        {
          type: "tool-input-start",
          toolCallId: "t1",
          toolName: "execute",
          title: "Run command",
        },
        {
          type: "tool-input-available",
          toolCallId: "t1",
          toolName: "execute",
          input: {},
          title: "Run command",
        },
      ]);
    });

    test("text -> tool call -> text mints a new, different id for the second run", () => {
      const mapper = new AcpChunkMapper();

      mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" },
      });
      mapper.map({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        kind: "read",
        status: "pending",
      });
      const resumed = mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" },
      });

      expect(resumed).toEqual([
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "b" },
      ]);
    });

    test("a tool_call_update completed for a known toolCallId, after its input completed", () => {
      const mapper = new AcpChunkMapper();

      mapper.map({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        kind: "read",
        status: "pending",
      });
      const result = mapper.map({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "file contents" } },
        ],
      });

      expect(result).toEqual([
        {
          type: "tool-output-available",
          toolCallId: "t1",
          output: "file contents",
        },
      ]);
    });

    test("a tool_call_update completed with no prior tool_call still emits an output chunk", () => {
      // Defensive: nothing in PROTOCOL.md guarantees tool_call always precedes
      // tool_call_update in whatever this mapper is fed, and the mapper holds
      // no per-toolCallId state to require it.
      const mapper = new AcpChunkMapper();

      const result = mapper.map({
        sessionUpdate: "tool_call_update",
        toolCallId: "orphan",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      });

      expect(result).toEqual([
        { type: "tool-output-available", toolCallId: "orphan", output: "done" },
      ]);
    });

    test("finish() closes an open text run", () => {
      const mapper = new AcpChunkMapper();

      mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "unfinished" },
      });

      expect(mapper.finish()).toEqual([{ type: "text-end", id: "text-1" }]);
    });

    test("finish() is a no-op when nothing is open", () => {
      const mapper = new AcpChunkMapper();

      expect(mapper.finish()).toEqual([]);
    });

    test("finish() after finish() does not re-close the same block", () => {
      const mapper = new AcpChunkMapper();

      mapper.map({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x" },
      });

      expect(mapper.finish()).toEqual([{ type: "text-end", id: "text-1" }]);
      expect(mapper.finish()).toEqual([]);
    });
  });
});
