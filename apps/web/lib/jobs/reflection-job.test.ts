import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

mock.module("server-only", () => ({}));

let createQueueCalls = 0;
let scheduleCalls: Array<{ name: string; cron: string }> = [];
let workHandler:
  | ((jobs: Array<{ data: object }>) => Promise<unknown>)
  | undefined;
let workCalls = 0;

const fakeBoss = {
  createQueue: (_name: string) => {
    createQueueCalls += 1;
    return Promise.resolve();
  },
  schedule: (name: string, cron: string) => {
    scheduleCalls.push({ name, cron });
    return Promise.resolve();
  },
  work: (
    _name: string,
    _options: unknown,
    handler: (jobs: Array<{ data: object }>) => Promise<unknown>,
  ) => {
    workCalls += 1;
    workHandler = handler;
    return Promise.resolve("worker-1");
  },
};

const getBossSpy = mock(() => Promise.resolve(fakeBoss));

mock.module("./queue", () => ({ getBoss: getBossSpy }));

let organization: { id: string } | null = { id: "org-1" };
const getOrganizationSpy = mock(() => Promise.resolve(organization));

mock.module("@/lib/org/organization", () => ({
  getOrganization: getOrganizationSpy,
}));

let reflectCalls: Array<{ organizationId: string }> = [];
const reflectSpy = mock((params: { organizationId: string }) => {
  reflectCalls.push(params);
  return Promise.resolve({ proposals: 0 });
});

mock.module("@/lib/memory/reflect", () => ({
  reflectOnRecentSessions: reflectSpy,
}));

describe("startReflectionJob", () => {
  beforeEach(() => {
    createQueueCalls = 0;
    scheduleCalls = [];
    workCalls = 0;
    workHandler = undefined;
    organization = { id: "org-1" };
    reflectCalls = [];
    getBossSpy.mockClear();
    getOrganizationSpy.mockClear();
    reflectSpy.mockClear();
  });

  test("registers the queue, the daily cron schedule, and a worker exactly once", async () => {
    // Fresh module per test: the registration guard is a module-level
    // singleton, same as `workers.ts`'s `started`, so re-importing after
    // resetting the module registry gives each test its own guard instead
    // of inheriting state a previous test already flipped.
    mock.restore();
    mock.module("server-only", () => ({}));
    mock.module("./queue", () => ({ getBoss: getBossSpy }));
    mock.module("@/lib/org/organization", () => ({
      getOrganization: getOrganizationSpy,
    }));
    mock.module("@/lib/memory/reflect", () => ({
      reflectOnRecentSessions: reflectSpy,
    }));

    const { startReflectionJob } = await import(
      `./reflection-job?case=${Math.random()}`
    );

    await startReflectionJob();

    expect(createQueueCalls).toBe(1);
    expect(scheduleCalls).toEqual([{ name: "reflection", cron: "0 4 * * *" }]);
    expect(workCalls).toBe(1);
  });

  test("calling it twice does not double-register", async () => {
    const { startReflectionJob } = await import(
      `./reflection-job?case=${Math.random()}`
    );

    await startReflectionJob();
    await startReflectionJob();

    expect(createQueueCalls).toBe(1);
    expect(scheduleCalls.length).toBe(1);
    expect(workCalls).toBe(1);
    expect(getBossSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent calls share the same in-flight registration", async () => {
    const { startReflectionJob } = await import(
      `./reflection-job?case=${Math.random()}`
    );

    const [a, b] = await Promise.all([
      startReflectionJob(),
      startReflectionJob(),
    ]);

    expect(a).toBe(b);
    expect(createQueueCalls).toBe(1);
    expect(workCalls).toBe(1);
  });

  test("the worker reflects on the org's sessions when an organization exists", async () => {
    const { startReflectionJob } = await import(
      `./reflection-job?case=${Math.random()}`
    );

    await startReflectionJob();
    await workHandler?.([{ data: {} }]);

    expect(reflectCalls).toEqual([{ organizationId: "org-1" }]);
  });

  test("the worker no-ops when there is no organization yet", async () => {
    organization = null;
    const { startReflectionJob } = await import(
      `./reflection-job?case=${Math.random()}`
    );

    await startReflectionJob();
    await workHandler?.([{ data: {} }]);

    expect(reflectSpy).not.toHaveBeenCalled();
  });
});

/**
 * Registering the job here does nothing on a real deployment unless
 * something actually calls `startReflectionJob` at boot — `workers.ts` and
 * `schedule-job.ts` are both wired into `instrumentation.ts`'s `register()`,
 * and this must be too, or the "0 4 * * *" cron never gets created and
 * reflection silently never runs.
 *
 * There is no `instrumentation.test.ts` to extend the way the brief asked
 * for (no sibling job has one either — `workers.ts` and `schedule-job.ts`
 * are both verified this same way: nothing exercises `register()` directly),
 * so this is a source-scan guard instead: it fails loudly if a future edit
 * to `instrumentation.ts` ever drops the wiring, which a purely
 * behavioral test of this module never could (this module has no way to
 * observe whether anything outside it calls its own exported function).
 */
describe("startReflectionJob wiring", () => {
  test("instrumentation.ts's register() calls startReflectionJob at boot", async () => {
    const instrumentationSource = await fs.readFile(
      path.join(import.meta.dir, "..", "..", "instrumentation.ts"),
      "utf-8",
    );

    expect(instrumentationSource).toContain("@/lib/jobs/reflection-job");
    expect(instrumentationSource).toContain("startReflectionJob()");
  });
});
