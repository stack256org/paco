import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { getReasoningGroupText, groupMessagesForRender } =
  await import("./message-render-groups");

function reasoning(text: string) {
  return { type: "reasoning", text } as never;
}

function text(value: string) {
  return { type: "text", text: value } as never;
}

function tool(toolCallId: string) {
  return { type: "tool-Bash", toolCallId, state: "output-available" } as never;
}

function assistant(parts: unknown[]) {
  return { id: "m1", role: "assistant", parts } as never;
}

describe("groupMessagesForRender", () => {
  test("collapses a run of reasoning parts into one group", () => {
    const [grouped] = groupMessagesForRender(
      [assistant([reasoning("a"), reasoning("b"), text("done")])],
      false,
    );

    expect(grouped?.groups.map((g) => g.type)).toEqual([
      "reasoning-group",
      "part",
    ]);
  });

  test("starts a new group after non-reasoning content interrupts", () => {
    const [grouped] = groupMessagesForRender(
      [assistant([reasoning("a"), tool("t1"), reasoning("b")])],
      false,
    );

    expect(grouped?.groups.map((g) => g.type)).toEqual([
      "reasoning-group",
      "part",
      "reasoning-group",
    ]);
  });

  test("keys a tool call by its id, so it survives later parts streaming in", () => {
    // Keying by array index would remount the tool call as parts arrive,
    // collapsing an expanded call mid-stream.
    const before = groupMessagesForRender([assistant([tool("t1")])], true);
    const after = groupMessagesForRender(
      [assistant([tool("t1"), text("and then")])],
      true,
    );

    expect(before[0]?.groups[0]?.renderKey).toBe("tool:t1");
    expect(after[0]?.groups[0]?.renderKey).toBe("tool:t1");
  });

  test("disambiguates repeated parts of the same kind by occurrence", () => {
    const [grouped] = groupMessagesForRender(
      [assistant([text("one"), text("two")])],
      false,
    );

    expect(grouped?.groups.map((g) => g.renderKey)).toEqual([
      "text:0",
      "text:1",
    ]);
  });

  test("marks only the last message as streaming, and only while in flight", () => {
    const messages = [assistant([text("a")]), assistant([text("b")])];

    expect(
      groupMessagesForRender(messages, true).map((g) => g.isStreaming),
    ).toEqual([false, true]);
    expect(
      groupMessagesForRender(messages, false).map((g) => g.isStreaming),
    ).toEqual([false, false]);
  });
});

describe("getReasoningGroupText", () => {
  test("joins parts with a blank line and drops empty ones", () => {
    expect(
      getReasoningGroupText([reasoning("a"), reasoning("   "), reasoning("b")]),
    ).toBe("a\n\nb");
  });
});
