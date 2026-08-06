import { describe, expect, mock, test } from "bun:test";

// `lib/db/client.ts` opens a real Postgres pool the moment any property on
// its `db` proxy is touched. `readQueueHealth` below needs to drive what
// `db.execute` does per-test, so the module is replaced outright rather than
// reached into.
let executeImpl: () => Promise<unknown> = () => Promise.resolve([]);

mock.module("@/lib/db/client", () => ({
  db: { execute: () => executeImpl() },
}));

const queueHealthModule = import("./queue-health");
const { classifyQueue } = await queueHealthModule;

describe("classifyQueue", () => {
  test("nothing queued is idle", () => {
    expect(
      classifyQueue({
        pending: 0,
        failedLastHour: 0,
        oldestPendingAgeSeconds: null,
      }).state,
    ).toBe("idle");
  });

  test("a few fresh jobs is working, not a problem", () => {
    expect(
      classifyQueue({
        pending: 3,
        failedLastHour: 0,
        oldestPendingAgeSeconds: 5,
      }).state,
    ).toBe("working");
  });

  test("a job that has waited far too long is backed up", () => {
    expect(
      classifyQueue({
        pending: 1,
        failedLastHour: 0,
        oldestPendingAgeSeconds: 900,
      }).state,
    ).toBe("backed-up");
  });

  test("recent failures are reported as failing even when the queue is short", () => {
    expect(
      classifyQueue({
        pending: 0,
        failedLastHour: 4,
        oldestPendingAgeSeconds: null,
      }).state,
    ).toBe("failing");
  });

  test("failing outranks backed-up", () => {
    expect(
      classifyQueue({
        pending: 20,
        failedLastHour: 4,
        oldestPendingAgeSeconds: 900,
      }).state,
    ).toBe("failing");
  });
});

describe("readQueueHealth", () => {
  test("a genuinely empty queue is idle", async () => {
    executeImpl = () => Promise.resolve([{ count: 0, age: null }]);
    const { readQueueHealth } = await queueHealthModule;

    const health = await readQueueHealth();

    expect(health.state).toBe("idle");
  });

  // CRITICAL: this is the bug the queue card exists to prevent. A rejecting
  // query used to be caught and defaulted to `pending: 0, failedLastHour: 0,
  // oldestPendingAgeSeconds: null`, which `classifyQueue` reads as `"idle"`
  // — so Postgres being unreachable and the queue being genuinely empty were
  // indistinguishable on screen. `readQueueHealth` must reject instead, so
  // `Promise.allSettled` in `lib/admin/health-actions.ts` can turn it into
  // an honest `"unavailable"`.
  test("a rejecting query rejects readQueueHealth rather than reporting idle", async () => {
    executeImpl = () => Promise.reject(new Error("connection refused"));
    const { readQueueHealth } = await queueHealthModule;

    await expect(readQueueHealth()).rejects.toThrow("connection refused");
  });

  // The `pgboss` schema not existing yet (a very fresh install) is also not
  // "idle" — pg-boss has never started, so nothing is actually being
  // enqueued or delivered. This must reject just like any other failure,
  // not be special-cased into a default queue count.
  test("a missing pgboss schema also rejects rather than reporting idle", async () => {
    executeImpl = () =>
      Promise.reject(
        Object.assign(new Error('schema "pgboss" does not exist'), {
          code: "3F000",
        }),
      );
    const { readQueueHealth } = await queueHealthModule;

    await expect(readQueueHealth()).rejects.toThrow();
  });
});
