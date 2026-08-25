import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { parseChatDesignOptions } = await import("./design-options");

describe("parseChatDesignOptions", () => {
  test("accepts a plain (non-design) send unchanged", () => {
    const result = parseChatDesignOptions({ messages: [], chatId: "c1" });

    expect(result).toEqual({ ok: true, options: {} });
  });

  test("accepts mode: design and fills in the default candidate count", () => {
    const result = parseChatDesignOptions({ mode: "design" });

    expect(result).toEqual({
      ok: true,
      options: { mode: "design", designCandidateCount: 3 },
    });
  });

  test("accepts an explicit candidate count of 2", () => {
    const result = parseChatDesignOptions({
      mode: "design",
      designCandidateCount: 2,
    });

    expect(result).toEqual({
      ok: true,
      options: { mode: "design", designCandidateCount: 2 },
    });
  });

  test("rejects a candidate count the branch-naming rule cannot hold", () => {
    expect(
      parseChatDesignOptions({ mode: "design", designCandidateCount: 4 }).ok,
    ).toBe(false);
    expect(
      parseChatDesignOptions({ mode: "design", designCandidateCount: 0 }).ok,
    ).toBe(false);
  });

  test("rejects a mode Paco does not know", () => {
    expect(parseChatDesignOptions({ mode: "sketch" }).ok).toBe(false);
  });

  test("accepts an iteration targeting one existing candidate", () => {
    const result = parseChatDesignOptions({
      mode: "design",
      designIterateCandidate: 2,
    });

    expect(result).toEqual({
      ok: true,
      options: {
        mode: "design",
        designCandidateCount: 3,
        designIterateCandidate: 2,
      },
    });
  });

  test("rejects an iteration target outside 1..3", () => {
    expect(
      parseChatDesignOptions({ mode: "design", designIterateCandidate: 5 }).ok,
    ).toBe(false);
  });

  test("ignores design fields on a send that is not a design turn", () => {
    const result = parseChatDesignOptions({ designCandidateCount: 2 });

    expect(result).toEqual({ ok: true, options: {} });
  });

  test("rejects a body that is not an object at all", () => {
    expect(parseChatDesignOptions(null).ok).toBe(false);
  });
});
