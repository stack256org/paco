import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Schedule } from "@/lib/db/schema";
import type { Task } from "@/lib/db/schema";
import type { StartTaskResult } from "@/lib/tasks/start";

mock.module("server-only", () => ({}));

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sched-1",
    organizationId: "org-1",
    sessionId: "session-1",
    name: "Nightly suite",
    cron: "0 2 * * *",
    goal: "Run the suite; open a fix PR if it's red.",
    assignedAgent: null,
    enabled: true,
    lastFiredAt: null,
    createdBy: "user-1",
    createdAt: new Date("2026-08-25T00:00:00Z"),
    updatedAt: new Date("2026-08-25T00:00:00Z"),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    organizationId: "org-1",
    sessionId: "session-1",
    chatId: null,
    parentTaskId: null,
    title: "Nightly suite",
    goal: "Run the suite; open a fix PR if it's red.",
    status: "todo",
    assignedAgent: null,
    reviewerRejections: 0,
    origin: "schedule",
    resultSummary: null,
    createdBy: "user-1",
    createdAt: new Date("2026-08-25T00:00:00Z"),
    updatedAt: new Date("2026-08-25T00:00:00Z"),
    ...overrides,
  };
}

// ── `@/lib/db/schedules` ─────────────────────────────────────────

let scheduleRow: Schedule | undefined;
const getScheduleByIdMock = mock(async (_scheduleId: string) => scheduleRow);
const stampScheduleFiredMock = mock(
  async (_organizationId: string, _scheduleId: string, _firedAt: Date) => {
    // no-op; call arguments are asserted directly
  },
);

mock.module("@/lib/db/schedules", () => ({
  getScheduleById: getScheduleByIdMock,
  stampScheduleFired: stampScheduleFiredMock,
}));

// ── `@/lib/db/tasks` ─────────────────────────────────────────────

let createdTask: Task = makeTask();
const createTaskMock = mock(async (_input: unknown) => createdTask);

mock.module("@/lib/db/tasks", () => ({
  createTask: createTaskMock,
}));

// ── `@/lib/tasks/start` ──────────────────────────────────────────

let startTaskResult: StartTaskResult = { ok: true, chatId: "chat-1" };
const startTaskMock = mock(
  async (_organizationId: string, _taskId: string) => startTaskResult,
);

mock.module("@/lib/tasks/start", () => ({
  startTask: startTaskMock,
}));

const { fireSchedule } = await import("./fire");

beforeEach(() => {
  scheduleRow = makeSchedule();
  createdTask = makeTask();
  startTaskResult = { ok: true, chatId: "chat-1" };
  getScheduleByIdMock.mockClear();
  stampScheduleFiredMock.mockClear();
  createTaskMock.mockClear();
  startTaskMock.mockClear();
});

describe("fireSchedule", () => {
  test('creates a task with origin "schedule" and starts it', async () => {
    const result = await fireSchedule("sched-1");

    expect(result).toEqual({ ok: true, taskId: "task-1" });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const input = createTaskMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.origin).toBe("schedule");
    expect(input.organizationId).toBe("org-1");
    expect(input.sessionId).toBe("session-1");
    expect(input.goal).toBe("Run the suite; open a fix PR if it's red.");
    expect(startTaskMock).toHaveBeenCalledWith("org-1", "task-1");
  });

  test("stamps lastFiredAt", async () => {
    await fireSchedule("sched-1");

    expect(stampScheduleFiredMock).toHaveBeenCalledTimes(1);
    const [organizationId, scheduleId, firedAt] =
      stampScheduleFiredMock.mock.calls[0] ?? [];
    expect(organizationId).toBe("org-1");
    expect(scheduleId).toBe("sched-1");
    expect(firedAt).toBeInstanceOf(Date);
  });

  test("a disabled schedule is skipped: no task, no stamp", async () => {
    scheduleRow = makeSchedule({ enabled: false });

    const result = await fireSchedule("sched-1");

    expect(result.ok).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(stampScheduleFiredMock).not.toHaveBeenCalled();
  });

  test("a missing schedule is skipped: no task, no stamp", async () => {
    scheduleRow = undefined;

    const result = await fireSchedule("sched-1");

    expect(result.ok).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(stampScheduleFiredMock).not.toHaveBeenCalled();
  });

  test("a startTask failure is surfaced as a result, not thrown, but is still stamped", async () => {
    startTaskResult = { ok: false, error: "session not found" };

    const result = await fireSchedule("sched-1");

    expect(result).toEqual({ ok: false, error: "session not found" });
    expect(stampScheduleFiredMock).toHaveBeenCalledTimes(1);
  });
});
