import { describe, expect, test } from "bun:test";
import {
  DEV_SERVER_SLOW_START_MESSAGE,
  isDevServerListening,
  waitForDevServerReady,
} from "./dev-server-readiness";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A clock the test drives, so a four-minute timeout runs instantly. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

describe("isDevServerListening", () => {
  test("only `running: true` counts", () => {
    expect(isDevServerListening({ running: true })).toBe(true);
    expect(isDevServerListening({ running: false })).toBe(false);
    expect(isDevServerListening({})).toBe(false);
    expect(isDevServerListening(null)).toBe(false);
    expect(isDevServerListening("running")).toBe(false);
  });

  test("a truthy non-boolean is not a listening server", () => {
    // The status route answers `{running:false}` while `npm install` runs. A
    // loose check here is what let the panel call an installing app "ready".
    expect(isDevServerListening({ running: "true" })).toBe(false);
    expect(isDevServerListening({ running: 1 })).toBe(false);
  });
});

describe("waitForDevServerReady", () => {
  test("resolves as soon as the port answers", async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("keeps waiting through a long install, then succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: () => {
        calls += 1;
        // Nothing is listening for the first 30 polls — a cold install.
        return Promise.resolve(jsonResponse({ running: calls > 30 }));
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(31);
  });

  test("gives up with actionable copy when nothing ever listens", async () => {
    const clock = fakeClock();

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: () => Promise.resolve(jsonResponse({ running: false })),
    });

    // This is the silent-dead-preview case: `npm install` failed into
    // /dev/null. It used to leave the panel on "running" against a dead port
    // with no message at all.
    expect(result.ok).toBe(false);
    expect(result).toEqual({
      // `lastOutput` is asked for once the wait is exhausted; this fetch stub
      // answers every URL the same way, so there is no log to report.
      lastOutput: null,
      message: DEV_SERVER_SLOW_START_MESSAGE,
      ok: false,
    });
  });

  test("a failing probe is a reason to keep waiting, not to declare failure", async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: () => {
        calls += 1;
        if (calls < 4) {
          return Promise.reject(new Error("Failed to fetch"));
        }
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    expect(result).toEqual({ ok: true });
  });

  test("a 500 from the status route does not end the wait", async () => {
    const clock = fakeClock();
    let calls = 0;

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: () => {
        calls += 1;
        if (calls < 3) {
          return Promise.resolve(jsonResponse({ error: "nope" }, false));
        }
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    expect(result).toEqual({ ok: true });
  });

  test("abandons the wait when the user has moved on", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    const result = await waitForDevServerReady({
      sessionId: "s1",
      chatId: "c1",
      now: clock.now,
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        calls += 1;
        if (calls === 3) {
          cancelled = true;
        }
        return Promise.resolve(jsonResponse({ running: false }));
      },
    });

    expect(result.ok).toBe(false);
    // Stopped promptly rather than polling for the full four minutes.
    expect(calls).toBe(3);
  });

  test("scopes the request to the chat's own worktree", async () => {
    const clock = fakeClock();
    let requested = "";

    await waitForDevServerReady({
      sessionId: "s1",
      chatId: "chat/with slash",
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (url) => {
        requested = url;
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    expect(requested).toBe(
      "/api/sessions/s1/dev-server?chatId=chat%2Fwith%20slash",
    );
  });

  test("the give-up message says what to do next", () => {
    expect(DEV_SERVER_SLOW_START_MESSAGE).toMatch(/Start preview/);
    expect(DEV_SERVER_SLOW_START_MESSAGE).not.toMatch(/ECONN|500|undefined/);
  });
});

describe("waitForDevServerReady, when the wait runs out", () => {
  test("asks for the log once, and only after giving up", async () => {
    const clock = fakeClock();
    const requested: string[] = [];

    const result = await waitForDevServerReady({
      chatId: "chat-1",
      fetchImpl: (url) => {
        requested.push(url);
        return Promise.resolve(
          Response.json(
            url.includes("logs=1")
              ? { lastOutput: "npm ERR! peer dep missing", running: false }
              : { running: false },
          ),
        );
      },
      intervalMs: 1000,
      now: clock.now,
      sessionId: "session-1",
      sleep: clock.sleep,
      timeoutMs: 3000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastOutput).toBe("npm ERR! peer dep missing");
    }

    // Exactly one log request, and it is the last thing asked for — the poll
    // itself must never pay for a log it does not use.
    const logRequests = requested.filter((url) => url.includes("logs=1"));
    expect(logRequests).toHaveLength(1);
    expect(requested.at(-1)).toContain("logs=1");
  });

  test("a log that cannot be read still leaves a usable timeout message", async () => {
    const clock = fakeClock();
    const result = await waitForDevServerReady({
      chatId: "chat-1",
      fetchImpl: (url) =>
        url.includes("logs=1")
          ? Promise.reject(new Error("network gone"))
          : Promise.resolve(Response.json({ running: false })),
      intervalMs: 1000,
      now: clock.now,
      sessionId: "session-1",
      sleep: clock.sleep,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastOutput).toBeNull();
      expect(result.message).toContain("hasn't started responding yet");
    }
  });

  test("says nothing when the log is only whitespace", async () => {
    const clock = fakeClock();
    const result = await waitForDevServerReady({
      chatId: "chat-1",
      fetchImpl: (url) =>
        Promise.resolve(
          Response.json(
            url.includes("logs=1")
              ? { lastOutput: "  \n  ", running: false }
              : { running: false },
          ),
        ),
      intervalMs: 1000,
      now: clock.now,
      sessionId: "session-1",
      sleep: clock.sleep,
      timeoutMs: 2000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.lastOutput).toBeNull();
    }
  });

  test("does not fetch a log when the wait was abandoned", async () => {
    const clock = fakeClock();
    const requested: string[] = [];

    await waitForDevServerReady({
      chatId: "chat-1",
      fetchImpl: (url) => {
        requested.push(url);
        return Promise.resolve(Response.json({ running: false }));
      },
      intervalMs: 1000,
      isCancelled: () => true,
      now: clock.now,
      sessionId: "session-1",
      sleep: clock.sleep,
      timeoutMs: 5000,
    });

    // The user left. Nothing is owed an explanation.
    expect(requested.filter((url) => url.includes("logs=1"))).toHaveLength(0);
  });
});
