import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type WorkHandler = (
  jobs: Array<{ data: { scheduleId: string } }>,
) => Promise<void>;

const createQueueMock = mock(async (_name: string) => {
  // no-op
});
const workMock = mock(
  async (_name: string, _options: unknown, handler: WorkHandler) => {
    registeredHandler = handler;
  },
);
const scheduleMock = mock(
  async (
    _name: string,
    _cron: string,
    _data: unknown,
    _options: { key?: string; tz?: string },
  ) => {
    // no-op
  },
);
const unscheduleMock = mock(async (_name: string, _key?: string) => {
  // no-op
});

let registeredHandler: WorkHandler | undefined;

const fakeBoss = {
  createQueue: createQueueMock,
  work: workMock,
  schedule: scheduleMock,
  unschedule: unscheduleMock,
};

const getBossMock = mock(async () => fakeBoss);

mock.module("@/lib/jobs/queue", () => ({
  getBoss: getBossMock,
  QUEUES: { fireSchedule: "fire-schedule" },
}));

// Matches the relative specifier `schedule-job.ts` actually imports
// (`./queue`) — mocked separately from the `@/lib/jobs/queue` alias above
// in case Bun's module registry treats the two specifiers independently
// rather than resolving them to the same entry.
mock.module("./queue", () => ({
  getBoss: getBossMock,
  QUEUES: { fireSchedule: "fire-schedule" },
}));

type FireScheduleResult =
  | { ok: true; taskId: string }
  | { ok: false; error: string };

const fireScheduleMock = mock(
  async (_scheduleId: string): Promise<FireScheduleResult> => ({
    ok: true,
    taskId: "task-1",
  }),
);

mock.module("@/lib/schedules/fire", () => ({
  fireSchedule: fireScheduleMock,
}));

const { startScheduleJob, syncScheduleRegistration, unregisterSchedule } =
  await import("./schedule-job");

beforeEach(() => {
  // `registeredHandler` is deliberately NOT reset here: `startScheduleJob`
  // caches its registration at module scope (the same "safe to call more
  // than once" shape as `startWorkers` in `workers.ts`), so once one test in
  // this file has actually invoked `registerScheduleWorker`, later calls in
  // later tests are expected to be no-ops that never touch `workMock`
  // again — exactly the behaviour "registration idempotence" is testing.
  getBossMock.mockClear();
  createQueueMock.mockClear();
  workMock.mockClear();
  scheduleMock.mockClear();
  unscheduleMock.mockClear();
  fireScheduleMock.mockClear();
});

describe("startScheduleJob", () => {
  test("registers the worker exactly once even when called concurrently and repeatedly", async () => {
    const [a, b] = await Promise.all([startScheduleJob(), startScheduleJob()]);
    await startScheduleJob();

    expect(a).toBe(b);
    expect(workMock).toHaveBeenCalledTimes(1);
    expect(registeredHandler).toBeDefined();
  });

  test("the registered handler fires the schedule named in the job data", async () => {
    await startScheduleJob();
    // Already registered by the previous test; this call must not touch
    // `boss.work` again.
    expect(workMock).not.toHaveBeenCalled();

    await registeredHandler?.([{ data: { scheduleId: "sched-1" } }]);

    expect(fireScheduleMock).toHaveBeenCalledWith("sched-1");
  });

  test("a fire that comes back not-ok is logged, not thrown", async () => {
    fireScheduleMock.mockImplementationOnce(
      async (): Promise<FireScheduleResult> => ({
        ok: false,
        error: "disabled",
      }),
    );
    await startScheduleJob();

    await expect(
      registeredHandler?.([{ data: { scheduleId: "sched-1" } }]),
    ).resolves.toBeUndefined();
  });
});

describe("syncScheduleRegistration", () => {
  test("registers an enabled schedule on pg-boss's cron API, keyed by its id", async () => {
    await syncScheduleRegistration({
      id: "sched-1",
      cron: "0 2 * * *",
      enabled: true,
    });

    expect(scheduleMock).toHaveBeenCalledWith(
      "fire-schedule",
      "0 2 * * *",
      { scheduleId: "sched-1" },
      { key: "sched-1", tz: "UTC" },
    );
    expect(unscheduleMock).not.toHaveBeenCalled();
  });

  test("registering the same schedule twice is idempotent (same key both times)", async () => {
    await syncScheduleRegistration({
      id: "sched-1",
      cron: "0 2 * * *",
      enabled: true,
    });
    await syncScheduleRegistration({
      id: "sched-1",
      cron: "0 2 * * *",
      enabled: true,
    });

    expect(scheduleMock).toHaveBeenCalledTimes(2);
    const firstKey = scheduleMock.mock.calls[0]?.[3]?.key;
    const secondKey = scheduleMock.mock.calls[1]?.[3]?.key;
    expect(firstKey).toBe(secondKey);
  });

  test("a disabled schedule is unscheduled instead of registered", async () => {
    await syncScheduleRegistration({
      id: "sched-1",
      cron: "0 2 * * *",
      enabled: false,
    });

    expect(unscheduleMock).toHaveBeenCalledWith("fire-schedule", "sched-1");
    expect(scheduleMock).not.toHaveBeenCalled();
  });
});

describe("unregisterSchedule", () => {
  test("unschedules by id", async () => {
    await unregisterSchedule("sched-1");

    expect(unscheduleMock).toHaveBeenCalledWith("fire-schedule", "sched-1");
  });
});
