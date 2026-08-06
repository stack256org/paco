import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { MIN_REFRESH_INTERVAL_MS, shouldRefresh } = await import("./pr-refresh");

const NOW = 1_700_000_000_000;

function session(overrides: Partial<Parameters<typeof shouldRefresh>[0]> = {}) {
  return {
    id: "s1",
    prNumber: 7,
    prStatus: "open" as const,
    prCheckedAt: null,
    sandboxState: { sandboxName: "session_1" },
    latestChatId: "chat-1",
    ...overrides,
  };
}

describe("shouldRefresh", () => {
  test("refreshes an open pull request that has never been checked", () => {
    expect(shouldRefresh(session(), NOW)).toBe(true);
  });

  test("never refreshes a merged or closed pull request", () => {
    // Both are final. This is what keeps a long list of finished sessions from
    // costing anything on every poll.
    expect(shouldRefresh(session({ prStatus: "merged" }), NOW)).toBe(false);
    expect(shouldRefresh(session({ prStatus: "closed" }), NOW)).toBe(false);
  });

  test("skips a session with no pull request at all", () => {
    expect(shouldRefresh(session({ prNumber: null }), NOW)).toBe(false);
    expect(shouldRefresh(session({ prStatus: null }), NOW)).toBe(false);
  });

  test("waits out the interval before asking again", () => {
    // The sidebar polls every 3s while a session streams; asking GitHub that
    // often would burn rate limit and fork a process each time.
    const justChecked = session({
      prCheckedAt: new Date(NOW - MIN_REFRESH_INTERVAL_MS + 1_000),
    });
    expect(shouldRefresh(justChecked, NOW)).toBe(false);

    const stale = session({
      prCheckedAt: new Date(NOW - MIN_REFRESH_INTERVAL_MS - 1),
    });
    expect(shouldRefresh(stale, NOW)).toBe(true);
  });

  test("skips a session with no sandbox or no chat", () => {
    // `gh` reads the repository from a working directory, and the only one that
    // exists is a chat's worktree inside a live sandbox.
    expect(shouldRefresh(session({ sandboxState: null }), NOW)).toBe(false);
    expect(shouldRefresh(session({ latestChatId: null }), NOW)).toBe(false);
  });
});
