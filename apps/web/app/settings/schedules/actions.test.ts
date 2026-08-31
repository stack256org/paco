import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Schedule } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

// ── org ──────────────────────────────────────────────────────────

const organization = { id: "org-1" };

mock.module("@/lib/org/organization", () => ({
  getOrganization: async () => organization,
}));

// ── sessions / roster ────────────────────────────────────────────

let allSessions: Array<{ id: string; title: string; status: string }> = [
  { id: "session-1", title: "My repo", status: "running" },
];

mock.module("@/lib/db/sessions", () => ({
  getSessions: async () => allSessions,
}));

let roster: Record<string, unknown> = { explorer: {}, executor: {} };

mock.module("@/lib/db/roster", () => ({
  getRoster: async (_organizationId: string) => roster,
}));

// ── @/lib/db/schedules ───────────────────────────────────────────

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
    createdBy: null,
    createdAt: new Date("2026-08-25T00:00:00Z"),
    updatedAt: new Date("2026-08-25T00:00:00Z"),
    ...overrides,
  };
}

let store: Schedule[] = [];

const listSchedulesMock = mock(async (_organizationId: string) => store);
const getScheduleMock = mock(
  async (organizationId: string, scheduleId: string) =>
    store.find(
      (row) => row.organizationId === organizationId && row.id === scheduleId,
    ),
);
const createScheduleMock = mock(
  async (input: {
    organizationId: string;
    sessionId: string;
    name: string;
    cron: string;
    goal: string;
    assignedAgent?: string | null;
  }) => {
    if (input.cron === "garbage") {
      return { ok: false as const, error: "Invalid cron expression" };
    }
    const row = makeSchedule({
      id: `sched-${store.length + 1}`,
      ...input,
      assignedAgent: input.assignedAgent ?? null,
    });
    store.push(row);
    return { ok: true as const, schedule: row };
  },
);
const updateScheduleMock = mock(
  async (
    organizationId: string,
    scheduleId: string,
    input: {
      name: string;
      sessionId: string;
      cron: string;
      goal: string;
      assignedAgent?: string | null;
    },
  ) => {
    if (input.cron === "garbage") {
      return { ok: false as const, error: "Invalid cron expression" };
    }
    const row = store.find(
      (existing) =>
        existing.organizationId === organizationId &&
        existing.id === scheduleId,
    );
    if (!row) {
      return {
        ok: false as const,
        error: `Schedule "${scheduleId}" not found`,
      };
    }
    Object.assign(row, input);
    return { ok: true as const, schedule: row };
  },
);
const setScheduleEnabledMock = mock(
  async (organizationId: string, scheduleId: string, enabled: boolean) => {
    const row = store.find(
      (existing) =>
        existing.organizationId === organizationId &&
        existing.id === scheduleId,
    );
    if (row) {
      row.enabled = enabled;
    }
    return row;
  },
);
const deleteScheduleMock = mock(
  async (organizationId: string, scheduleId: string) => {
    const before = store.length;
    store = store.filter(
      (row) =>
        !(row.organizationId === organizationId && row.id === scheduleId),
    );
    return store.length < before;
  },
);

mock.module("@/lib/db/schedules", () => ({
  listSchedules: listSchedulesMock,
  getSchedule: getScheduleMock,
  createSchedule: createScheduleMock,
  updateSchedule: updateScheduleMock,
  setScheduleEnabled: setScheduleEnabledMock,
  deleteSchedule: deleteScheduleMock,
}));

// ── @/lib/jobs/schedule-job ──────────────────────────────────────

const syncScheduleRegistrationMock = mock(async (_schedule: unknown) => {
  // no-op
});
const unregisterScheduleMock = mock(async (_scheduleId: string) => {
  // no-op
});

mock.module("@/lib/jobs/schedule-job", () => ({
  syncScheduleRegistration: syncScheduleRegistrationMock,
  unregisterSchedule: unregisterScheduleMock,
}));

// ── @/lib/schedules/fire ─────────────────────────────────────────

let fireResult: { ok: true; taskId: string } | { ok: false; error: string } = {
  ok: true,
  taskId: "task-1",
};
const fireScheduleMock = mock(async (_scheduleId: string) => fireResult);

mock.module("@/lib/schedules/fire", () => ({
  fireSchedule: fireScheduleMock,
}));

const {
  createScheduleAction,
  deleteScheduleAction,
  listSchedulesAction,
  runScheduleNowAction,
  setScheduleEnabledAction,
  updateScheduleAction,
} = await import("./actions");

beforeEach(() => {
  allSessions = [{ id: "session-1", title: "My repo", status: "running" }];
  roster = { explorer: {}, executor: {} };
  store = [];
  fireResult = { ok: true, taskId: "task-1" };
  listSchedulesMock.mockClear();
  getScheduleMock.mockClear();
  createScheduleMock.mockClear();
  updateScheduleMock.mockClear();
  setScheduleEnabledMock.mockClear();
  deleteScheduleMock.mockClear();
  syncScheduleRegistrationMock.mockClear();
  unregisterScheduleMock.mockClear();
  fireScheduleMock.mockClear();
});

const VALID_INPUT = {
  name: "Nightly suite",
  sessionId: "session-1",
  cron: "0 2 * * *",
  goal: "Run the suite; open a fix PR if it's red.",
};

describe("listSchedulesAction", () => {
  test("lists every schedule in the organisation", async () => {
    store = [makeSchedule()];

    const rows = await listSchedulesAction();
    expect(rows).toHaveLength(1);
  });
});

describe("createScheduleAction", () => {
  test("creates a schedule and syncs its pg-boss registration", async () => {
    const result = await createScheduleAction(VALID_INPUT);

    expect(result.success).toBe(true);
    expect(syncScheduleRegistrationMock).toHaveBeenCalledTimes(1);
  });

  test("a bad cron comes back as an inline field error, not a throw", async () => {
    const result = await createScheduleAction({
      ...VALID_INPUT,
      cron: "garbage",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.cron).toBeDefined();
    }
    expect(syncScheduleRegistrationMock).not.toHaveBeenCalled();
  });

  test("a missing goal comes back as a field error", async () => {
    const result = await createScheduleAction({ ...VALID_INPUT, goal: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.goal).toBeDefined();
    }
  });

  /*
   * A schedule that names an agent the roster has never heard of still
   * fires: `buildTaskPrompt` (`lib/tasks/start.ts`) reads the stored name
   * straight out of the row and instructs the executor to delegate to it.
   * The picker only ever offers enabled names, and `createTaskAction`
   * validates the same field on the task path — this is the one write that
   * did not.
   */
  test("an assignedAgent that is not in the roster is rejected", async () => {
    const result = await createScheduleAction({
      ...VALID_INPUT,
      assignedAgent: "ghost",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.assignedAgent).toBeDefined();
    }
    expect(createScheduleMock).not.toHaveBeenCalled();
    expect(syncScheduleRegistrationMock).not.toHaveBeenCalled();
  });

  test("an assignedAgent that IS in the roster is accepted", async () => {
    const result = await createScheduleAction({
      ...VALID_INPUT,
      assignedAgent: "explorer",
    });

    expect(result.success).toBe(true);
    expect(store[0]?.assignedAgent).toBe("explorer");
  });

  test("a null assignedAgent stays null without consulting the roster", async () => {
    roster = {};

    const result = await createScheduleAction({
      ...VALID_INPUT,
      assignedAgent: null,
    });

    expect(result.success).toBe(true);
    expect(store[0]?.assignedAgent).toBeNull();
  });

  /*
   * `getRoster` seeds `DEFAULT_ROSTER` lazily, so an agent disabled after a
   * schedule was written simply drops out of the map — the same "enabled
   * roster row" test `createTaskAction` applies.
   */
  test("an agent that has since been disabled is rejected", async () => {
    roster = { executor: {} };

    const result = await createScheduleAction({
      ...VALID_INPUT,
      assignedAgent: "explorer",
    });

    expect(result.success).toBe(false);
  });
});

describe("updateScheduleAction", () => {
  test("a bad cron on edit comes back as a field error", async () => {
    store = [makeSchedule()];

    const result = await updateScheduleAction("sched-1", {
      ...VALID_INPUT,
      cron: "garbage",
    });

    expect(result.success).toBe(false);
    expect(syncScheduleRegistrationMock).not.toHaveBeenCalled();
  });

  /** Same reasoning as the session check: an edit is caller input too. */
  test("retargeting an existing schedule at an unknown agent is rejected", async () => {
    store = [makeSchedule()];

    const result = await updateScheduleAction("sched-1", {
      ...VALID_INPUT,
      assignedAgent: "ghost",
    });

    expect(result.success).toBe(false);
    expect(updateScheduleMock).not.toHaveBeenCalled();
    expect(store[0]?.assignedAgent).toBeNull();
  });
});

describe("setScheduleEnabledAction", () => {
  test("syncs the pg-boss registration after flipping enabled", async () => {
    store = [makeSchedule({ enabled: true })];

    const result = await setScheduleEnabledAction("sched-1", false);

    expect(result.success).toBe(true);
    expect(syncScheduleRegistrationMock).toHaveBeenCalledTimes(1);
  });
});

describe("deleteScheduleAction", () => {
  test("unregisters the pg-boss entry after deleting", async () => {
    store = [makeSchedule()];

    const result = await deleteScheduleAction("sched-1");

    expect(result.success).toBe(true);
    expect(unregisterScheduleMock).toHaveBeenCalledWith("sched-1");
  });
});

describe("runScheduleNowAction", () => {
  test("fires through the shared fire path and returns its result", async () => {
    store = [makeSchedule()];
    fireResult = { ok: true, taskId: "task-42" };

    const result = await runScheduleNowAction("sched-1");

    expect(result).toEqual({ success: true, taskId: "task-42" });
    expect(fireScheduleMock).toHaveBeenCalledWith("sched-1");
  });

  test("surfaces a disabled-schedule skip as a non-throwing failure", async () => {
    store = [makeSchedule({ enabled: false })];
    fireResult = { ok: false, error: "disabled" };

    const result = await runScheduleNowAction("sched-1");

    expect(result).toEqual({ success: false, error: "disabled" });
  });
});
