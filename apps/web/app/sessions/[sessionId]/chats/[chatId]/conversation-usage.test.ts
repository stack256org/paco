import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const {
  formatUsd,
  getConversationCost,
  getConversationUsage,
  getLatestContextUsage,
} = await import("./conversation-usage");

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
};

function assistant(metadata: Record<string, unknown>) {
  return { id: "a", role: "assistant", parts: [], metadata } as never;
}

function user() {
  return { id: "u", role: "user", parts: [] } as never;
}

const COST = { input: 3, output: 15, cache_read: 0.3 };

describe("formatUsd", () => {
  test("keeps four decimals for sub-cent amounts", () => {
    // Anything coarser renders a real cost as "$0.00", which reads as free.
    expect(formatUsd(0.0004)).toBe("$0.0004");
  });

  test("uses two decimals from a cent upward and drops them past $100", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(1234.56)).toBe("$1,235");
  });
});

describe("getLatestContextUsage", () => {
  test("reads the last assistant step, not the sum", () => {
    // The ring shows what will overflow the context window: one step's input.
    const usage = getLatestContextUsage([
      assistant({ lastStepUsage: { inputTokens: 100 } satisfies Usage }),
      user(),
      assistant({ lastStepUsage: { inputTokens: 900 } satisfies Usage }),
    ]);

    expect(usage.inputTokens).toBe(900);
  });

  test("is zero when no assistant message reported a step", () => {
    expect(getLatestContextUsage([user()]).inputTokens).toBe(0);
  });

  test("prefers the detailed cache-read count over the flat one", () => {
    const usage = getLatestContextUsage([
      assistant({
        lastStepUsage: {
          cachedInputTokens: 5,
          inputTokenDetails: { cacheReadTokens: 42 },
        } satisfies Usage,
      }),
    ]);

    expect(usage.cachedInputTokens).toBe(42);
  });
});

describe("getConversationUsage", () => {
  test("sums assistant messages and ignores user ones", () => {
    const usage = getConversationUsage([
      assistant({ totalMessageUsage: { inputTokens: 10, outputTokens: 1 } }),
      user(),
      assistant({ totalMessageUsage: { inputTokens: 20, outputTokens: 2 } }),
    ]);

    expect(usage.inputTokens).toBe(30);
    expect(usage.outputTokens).toBe(3);
  });

  test("falls back to the last step when no message total exists", () => {
    const usage = getConversationUsage([
      assistant({ lastStepUsage: { inputTokens: 7 } satisfies Usage }),
    ]);

    expect(usage.inputTokens).toBe(7);
  });
});

describe("getConversationCost", () => {
  test("prefers the CLI-reported cost and marks it as reported", () => {
    const cost = getConversationCost(
      [
        assistant({
          totalMessageCost: 0.25,
          totalMessageUsage: { inputTokens: 1e6 },
        }),
      ],
      COST,
    );

    // The reported figure wins outright — the token estimate is not added on top.
    expect(cost).toEqual({ total: 0.25, source: "reported" });
  });

  test("estimates from tokens when nothing was reported", () => {
    const cost = getConversationCost(
      [assistant({ totalMessageUsage: { inputTokens: 1_000_000 } })],
      COST,
    );

    expect(cost?.source).toBe("estimate");
    expect(cost?.total).toBeGreaterThan(0);
  });

  test("marks a conversation as mixed when both kinds contributed", () => {
    const cost = getConversationCost(
      [
        assistant({ totalMessageCost: 0.5 }),
        assistant({ totalMessageUsage: { inputTokens: 1_000_000 } }),
      ],
      COST,
    );

    expect(cost?.source).toBe("mixed");
  });

  test("is undefined when nothing can be attributed", () => {
    // Undefined hides the row; zero would claim the conversation was free.
    expect(getConversationCost([user()], COST)).toBeUndefined();
    expect(getConversationCost([assistant({})], COST)).toBeUndefined();
  });

  test("ignores a negative or non-finite reported cost", () => {
    expect(
      getConversationCost([assistant({ totalMessageCost: -1 })], COST),
    ).toBeUndefined();
    expect(
      getConversationCost([assistant({ totalMessageCost: Number.NaN })], COST),
    ).toBeUndefined();
  });

  test("counts a reported zero rather than falling through to an estimate", () => {
    const cost = getConversationCost(
      [
        assistant({
          totalMessageCost: 0,
          totalMessageUsage: { inputTokens: 1e6 },
        }),
      ],
      COST,
    );

    expect(cost).toEqual({ total: 0, source: "reported" });
  });
});
