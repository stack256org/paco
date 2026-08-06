import { describe, expect, test } from "bun:test";
import {
  classifyDevServerProbe,
  DEV_SERVER_LIVENESS_MISS_THRESHOLD,
  DEV_SERVER_LIVENESS_POLL_INTERVAL_MS,
  describeDevServerCrash,
  type DevServerLivenessState,
  type DevServerProbe,
  INITIAL_DEV_SERVER_LIVENESS_STATE,
  reduceDevServerLiveness,
  summarizeDevServerOutput,
  watchDevServerLiveness,
} from "./dev-server-liveness";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A clock the test drives, so a five-second poll runs instantly. */
function fakeClock() {
  let current = 0;
  return {
    elapsed: () => current,
    sleep: (ms: number) => {
      current += ms;
      return Promise.resolve();
    },
  };
}

/** Feed a sequence of probes through the reducer and report the last step. */
function runProbes(probes: DevServerProbe[]): {
  state: DevServerLivenessState;
  crashed: boolean;
  crashedAfter: number | null;
} {
  let state = INITIAL_DEV_SERVER_LIVENESS_STATE;
  let crashed = false;
  let crashedAfter: number | null = null;

  probes.forEach((probe, index) => {
    const step = reduceDevServerLiveness(state, probe);
    state = step.state;
    crashed = step.crashed;
    if (step.crashed && crashedAfter === null) {
      crashedAfter = index + 1;
    }
  });

  return { state, crashed, crashedAfter };
}

const listening: DevServerProbe = { kind: "listening" };
const silent: DevServerProbe = { kind: "silent", lastOutput: null };
const unknown: DevServerProbe = { kind: "unknown" };

describe("classifyDevServerProbe", () => {
  test("`running: true` is the app answering", () => {
    expect(
      classifyDevServerProbe({ ok: true, body: { running: true } }),
    ).toEqual({ kind: "listening" });
  });

  test("`running: false` is silence, and carries any captured output", () => {
    expect(
      classifyDevServerProbe({
        ok: true,
        body: { running: false, lastOutput: "Error: boom" },
      }),
    ).toEqual({ kind: "silent", lastOutput: "Error: boom" });

    expect(
      classifyDevServerProbe({ ok: true, body: { running: false } }),
    ).toEqual({ kind: "silent", lastOutput: null });
  });

  test("a failed response says nothing about the app", () => {
    // The status route 500s, or 409s because the workspace went to sleep.
    // Neither is evidence that the user's app crashed, and treating it as such
    // would tear down a preview over a hiccup in Paco itself.
    expect(
      classifyDevServerProbe({ ok: false, body: { error: "asleep" } }),
    ).toEqual({ kind: "unknown" });
    expect(
      classifyDevServerProbe({ ok: false, body: { running: false } }),
    ).toEqual({ kind: "unknown" });
  });

  test("a body that answers neither way is unknown, not silence", () => {
    expect(classifyDevServerProbe({ ok: true, body: null })).toEqual({
      kind: "unknown",
    });
    expect(classifyDevServerProbe({ ok: true, body: {} })).toEqual({
      kind: "unknown",
    });
    expect(classifyDevServerProbe({ ok: true, body: "running" })).toEqual({
      kind: "unknown",
    });
  });

  test("a truthy non-boolean is not a listening server", () => {
    expect(classifyDevServerProbe({ ok: true, body: { running: 1 } })).toEqual({
      kind: "unknown",
    });
    expect(
      classifyDevServerProbe({ ok: true, body: { running: "true" } }),
    ).toEqual({ kind: "unknown" });
  });

  test("output that is not a string is dropped rather than rendered", () => {
    expect(
      classifyDevServerProbe({
        ok: true,
        body: { running: false, lastOutput: { lines: [] } },
      }),
    ).toEqual({ kind: "silent", lastOutput: null });
  });
});

describe("reduceDevServerLiveness", () => {
  test("a single miss is a blip, not a crash", () => {
    // The case this whole module exists to get right: a dev server bouncing
    // itself after a config change is gone for a second and comes straight
    // back. Calling that a crash would unmount a working preview.
    expect(runProbes([silent]).crashed).toBe(false);
    expect(runProbes([silent, silent]).crashed).toBe(false);
  });

  test("consecutive misses are a crash", () => {
    const run = runProbes([silent, silent, silent]);

    expect(run.crashed).toBe(true);
    expect(run.crashedAfter).toBe(DEV_SERVER_LIVENESS_MISS_THRESHOLD);
  });

  test("a miss followed by a recovery clears the count", () => {
    const run = runProbes([silent, silent, listening, silent, silent]);

    expect(run.crashed).toBe(false);
    expect(run.state.consecutiveSilentProbes).toBe(2);
  });

  test("misses must be consecutive to add up", () => {
    const run = runProbes([
      silent,
      listening,
      silent,
      listening,
      silent,
      listening,
      silent,
    ]);

    expect(run.crashed).toBe(false);
  });

  test("an unreachable probe neither counts nor clears", () => {
    // Losing the network is not the app crashing, and it is not the app
    // recovering either. The two misses stay on the books.
    const run = runProbes([silent, silent, unknown, unknown]);

    expect(run.crashed).toBe(false);
    expect(run.state.consecutiveSilentProbes).toBe(2);

    expect(runProbes([silent, silent, unknown, silent]).crashed).toBe(true);
  });

  test("a crash stays a crash if the reducer is called again", () => {
    const crashedState: DevServerLivenessState = {
      consecutiveSilentProbes: DEV_SERVER_LIVENESS_MISS_THRESHOLD,
      lastOutput: null,
    };

    expect(reduceDevServerLiveness(crashedState, unknown).crashed).toBe(true);
    expect(reduceDevServerLiveness(crashedState, silent).crashed).toBe(true);
    expect(reduceDevServerLiveness(crashedState, listening).crashed).toBe(
      false,
    );
  });

  test("output captured on any miss survives later misses that have none", () => {
    const run = runProbes([
      { kind: "silent", lastOutput: "Error: Cannot find module 'react'" },
      silent,
      silent,
    ]);

    expect(run.crashed).toBe(true);
    expect(run.state.lastOutput).toBe("Error: Cannot find module 'react'");
  });

  test("recovering forgets the old output", () => {
    const run = runProbes([
      { kind: "silent", lastOutput: "Error: boom" },
      listening,
    ]);

    expect(run.state).toEqual(INITIAL_DEV_SERVER_LIVENESS_STATE);
  });

  test("the threshold is configurable for callers that want to be twitchier", () => {
    expect(
      reduceDevServerLiveness(INITIAL_DEV_SERVER_LIVENESS_STATE, silent, 1),
    ).toMatchObject({ crashed: true });
  });

  test("the default cadence gives a restart time to come back", () => {
    const graceMs =
      DEV_SERVER_LIVENESS_POLL_INTERVAL_MS * DEV_SERVER_LIVENESS_MISS_THRESHOLD;

    // Long enough for a dev server to restart itself, short enough that nobody
    // is left staring at a dead iframe.
    expect(graceMs).toBeGreaterThanOrEqual(10_000);
    expect(graceMs).toBeLessThanOrEqual(30_000);
  });
});

describe("summarizeDevServerOutput", () => {
  test("keeps the end, which is where the reason is", () => {
    const raw = Array.from({ length: 40 }, (_, index) => `line ${index}`).join(
      "\n",
    );

    const summary = summarizeDevServerOutput(raw);

    expect(summary).toContain("line 39");
    expect(summary).not.toContain("line 0\n");
    expect(summary?.split("\n")).toHaveLength(6);
  });

  test("drops blank lines and trailing whitespace", () => {
    expect(summarizeDevServerOutput("\n\n  hello  \n\n")).toBe("  hello");
  });

  test("nothing to show is null, not an empty block", () => {
    expect(summarizeDevServerOutput("")).toBeNull();
    expect(summarizeDevServerOutput("   \n\n")).toBeNull();
    expect(summarizeDevServerOutput(null)).toBeNull();
    expect(summarizeDevServerOutput(undefined)).toBeNull();
  });

  test("a single enormous line is truncated from the front", () => {
    const summary = summarizeDevServerOutput("x".repeat(5000));

    expect(summary?.startsWith("…")).toBe(true);
    expect(summary?.length).toBe(501);
  });
});

describe("describeDevServerCrash", () => {
  test("explains the crash without a word of jargon", () => {
    const report = describeDevServerCrash({ packagePath: "root" });

    expect(report.headline).toBe("Your app stopped running");
    expect(report.message).toContain("Press Start preview");
    expect(report.message).toContain("ask the assistant in the chat");
    // Nothing here should read like a terminal.
    expect(report.message).not.toMatch(
      /port|process|SIGKILL|exit code|stderr|pid/i,
    );
  });

  test("names the package when the repo has more than one app", () => {
    const report = describeDevServerCrash({ packagePath: "apps/web" });

    expect(report.headline).toBe("Your app (apps/web) stopped running");
  });

  test("shows the app's own last words, labelled as theirs", () => {
    const report = describeDevServerCrash({
      packagePath: "root",
      lastOutput: "SyntaxError: Unexpected token in src/App.tsx:12",
    });

    // The output is returned beside the prose, not inside it: the panel sets
    // it as a code block, and concatenating the two forced a stack trace to be
    // rendered as a wrapped paragraph.
    expect(report.lastOutput).toContain(
      "SyntaxError: Unexpected token in src/App.tsx:12",
    );
    expect(report.message).not.toContain("SyntaxError");
    // The headline stays a single line, because it also goes in a toast.
    expect(report.headline).not.toContain("\n");
  });

  test("says nothing about output when there is none to show", () => {
    const report = describeDevServerCrash({
      packagePath: "root",
      lastOutput: "   ",
    });

    // Whitespace-only output is nothing to show, and must not become an
    // empty code block.
    expect(report.lastOutput).toBeNull();
  });
});

describe("watchDevServerLiveness", () => {
  test("watches indefinitely while the app keeps answering", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        calls += 1;
        if (calls === 200) {
          cancelled = true;
        }
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    // No crash, no timeout, no giving up: a healthy app is watched for as long
    // as its preview is on screen.
    expect(report).toBeNull();
    expect(calls).toBe(200);
  });

  test("reports a crash once the misses add up, and stops", async () => {
    const clock = fakeClock();
    let calls = 0;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(
          jsonResponse(
            calls > 2
              ? { running: false, lastOutput: "Error: boom" }
              : { running: true },
          ),
        );
      },
    });

    expect(report?.headline).toBe("Your app stopped running");
    expect(report?.lastOutput).toContain("Error: boom");
    // Two healthy polls, then exactly three misses — and then it stops asking.
    expect(calls).toBe(5);
  });

  test("survives a restart that drops the port for one poll", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    // The shape of an ordinary hot reload: up, briefly gone, up again.
    const answers = [true, false, false, true, true, true];

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        const running = answers[calls] ?? true;
        calls += 1;
        if (calls >= answers.length) {
          cancelled = true;
        }
        return Promise.resolve(jsonResponse({ running }));
      },
    });

    expect(report).toBeNull();
  });

  test("a backgrounded tab is not probed at all", async () => {
    const clock = fakeClock();
    let calls = 0;
    let visible = false;
    let cancelled = false;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: (ms) => {
        // Ten intervals hidden, then the user comes back.
        if (clock.elapsed() >= 50_000) {
          visible = true;
        }
        if (clock.elapsed() >= 60_000) {
          cancelled = true;
        }
        return clock.sleep(ms);
      },
      isCancelled: () => cancelled,
      isVisible: () => visible,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ running: true }));
      },
    });

    expect(report).toBeNull();
    // Not zero — the loop resumed the moment the tab came back — but far fewer
    // than the twelve ticks that elapsed.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(5);
  });

  test("a hidden tab does not accumulate misses while it is away", async () => {
    const clock = fakeClock();
    let visible = true;
    let cancelled = false;
    let calls = 0;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: (ms) => {
        if (clock.elapsed() >= 5000) {
          visible = false;
        }
        if (clock.elapsed() >= 100_000) {
          cancelled = true;
        }
        return clock.sleep(ms);
      },
      isCancelled: () => cancelled,
      isVisible: () => visible,
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ running: false }));
      },
    });

    // One miss before the tab went away, and none after — a crash needs three.
    expect(report).toBeNull();
    expect(calls).toBe(1);
  });

  test("stops promptly when the chat is left", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        calls += 1;
        cancelled = true;
        return Promise.resolve(jsonResponse({ running: false }));
      },
    });

    // The answer that arrived after cancellation is dropped rather than being
    // turned into a crash on a panel the user has already left.
    expect(report).toBeNull();
    expect(calls).toBe(1);
  });

  test("a network that keeps failing never becomes a crash", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        calls += 1;
        if (calls >= 20) {
          cancelled = true;
        }
        return Promise.reject(new Error("Failed to fetch"));
      },
    });

    expect(report).toBeNull();
  });

  test("a sleeping workspace is not reported as a crash", async () => {
    const clock = fakeClock();
    let calls = 0;
    let cancelled = false;

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      isCancelled: () => cancelled,
      fetchImpl: () => {
        calls += 1;
        if (calls >= 10) {
          cancelled = true;
        }
        // The 409 the route answers for a hibernating sandbox.
        return Promise.resolve(
          jsonResponse({ error: "This workspace is asleep." }, false),
        );
      },
    });

    expect(report).toBeNull();
  });

  test("asks for the app's output, scoped to this chat's worktree", async () => {
    const clock = fakeClock();
    let requested = "";

    await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "chat/with slash",
      packagePath: "root",
      sleep: clock.sleep,
      threshold: 1,
      fetchImpl: (url) => {
        requested = url;
        return Promise.resolve(jsonResponse({ running: false }));
      },
    });

    expect(requested).toBe(
      "/api/sessions/s1/dev-server?chatId=chat%2Fwith%20slash&logs=1",
    );
  });

  test("names the package that died when the repo has more than one", async () => {
    const clock = fakeClock();

    const report = await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "apps/web",
      sleep: clock.sleep,
      threshold: 1,
      fetchImpl: () => Promise.resolve(jsonResponse({ running: false })),
    });

    expect(report?.headline).toBe("Your app (apps/web) stopped running");
  });

  test("waits before the first probe rather than firing on mount", async () => {
    // The caller only starts this once the readiness wait has already confirmed
    // the port answers, so probing immediately would be asking a question that
    // was answered a moment ago.
    const clock = fakeClock();
    const elapsedAtFirstProbe: number[] = [];

    await watchDevServerLiveness({
      sessionId: "s1",
      chatId: "c1",
      packagePath: "root",
      sleep: clock.sleep,
      threshold: 1,
      fetchImpl: () => {
        elapsedAtFirstProbe.push(clock.elapsed());
        return Promise.resolve(jsonResponse({ running: false }));
      },
    });

    expect(elapsedAtFirstProbe[0]).toBe(DEV_SERVER_LIVENESS_POLL_INTERVAL_MS);
  });
});
