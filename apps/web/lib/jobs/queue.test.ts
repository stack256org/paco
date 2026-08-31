import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/url", () => ({
  postgresUrl: () => "postgres://localhost/paco-test",
}));

let startBehaviour: () => Promise<void> = () => Promise.resolve();
let constructed = 0;
let startCalls = 0;

class FakePgBoss {
  constructor() {
    constructed += 1;
  }
  on() {
    // The real one needs an error listener or it takes the process down.
  }
  start() {
    startCalls += 1;
    return startBehaviour();
  }
}

mock.module("pg-boss", () => ({ PgBoss: FakePgBoss }));

const queueModule = import("./queue");

describe("getBoss", () => {
  beforeEach(() => {
    constructed = 0;
    startCalls = 0;
    startBehaviour = () => Promise.resolve();
    (globalThis as typeof globalThis & { __pacoBoss?: unknown }).__pacoBoss =
      undefined;
  });

  test("starts once and reuses the instance", async () => {
    const { getBoss } = await queueModule;

    const first = await getBoss();
    const second = await getBoss();

    expect(first).toBe(second);
    expect(constructed).toBe(1);
    expect(startCalls).toBe(1);
  });

  /**
   * The regression this file exists for.
   *
   * The start promise was cached before it settled, so one unreachable-Postgres
   * moment at boot — the normal case when the app and the database come up
   * together — left a rejected promise on `globalThis` for the life of the
   * process. Every job that depends on the queue stayed broken long after
   * Postgres recovered, and only a restart fixed it.
   */
  test("does not remember a failed start", async () => {
    const { getBoss } = await queueModule;

    startBehaviour = () => Promise.reject(new Error("ECONNREFUSED"));
    await expect(getBoss()).rejects.toThrow("ECONNREFUSED");

    // Postgres comes back.
    startBehaviour = () => Promise.resolve();
    const recovered = await getBoss();

    expect(recovered).toBeDefined();
    expect(startCalls).toBe(2);
  });

  test("recovers after repeated failures rather than latching", async () => {
    const { getBoss } = await queueModule;

    startBehaviour = () => Promise.reject(new Error("still down"));
    await expect(getBoss()).rejects.toThrow();
    await expect(getBoss()).rejects.toThrow();
    await expect(getBoss()).rejects.toThrow();

    startBehaviour = () => Promise.resolve();
    await expect(getBoss()).resolves.toBeDefined();
    expect(startCalls).toBe(4);
  });

  test("a successful start is still only made once", async () => {
    const { getBoss } = await queueModule;

    const [a, b, c] = await Promise.all([getBoss(), getBoss(), getBoss()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(startCalls).toBe(1);
  });
});
