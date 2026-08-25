import { describe, expect, mock, test } from "bun:test";
import { schedules } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
mock.module("server-only", () => ({}));

type Row = {
  id: string;
  organizationId: string;
  sessionId: string;
  name: string;
  cron: string;
  goal: string;
  assignedAgent: string | null;
  enabled: boolean;
  lastFiredAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type Predicate = (row: Row) => boolean;

/**
 * Same fake-db trick as `lib/db/tasks.test.ts` / `lib/db/roster.test.ts`: a
 * tiny in-memory store plus real column objects from the schema, so a
 * mocked `eq`/`and` filters it the way Drizzle would filter real rows,
 * without standing up a real Postgres.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [schedules.id, "id"],
  [schedules.organizationId, "organizationId"],
  [schedules.sessionId, "sessionId"],
  [schedules.enabled, "enabled"],
]);

function keyFor(column: unknown): keyof Row {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

const actualDrizzle = await import("drizzle-orm");

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) =>
      row[keyFor(column)] === value,
  and:
    (...predicates: Predicate[]): Predicate =>
    (row) =>
      predicates.every((predicate) => predicate(row)),
  desc: (_column: unknown) => undefined,
}));

let store: Row[] = [];
let nextId = 1;

function makeRow(partial: Partial<Row>): Row {
  const now = new Date();
  return {
    id: partial.id ?? `schedule-${nextId++}`,
    organizationId: partial.organizationId ?? "org-1",
    sessionId: partial.sessionId ?? "session-1",
    name: partial.name ?? "Nightly suite",
    cron: partial.cron ?? "0 2 * * *",
    goal: partial.goal ?? "Run the suite; open a fix PR if it's red.",
    assignedAgent: partial.assignedAgent ?? null,
    enabled: partial.enabled ?? true,
    lastFiredAt: partial.lastFiredAt ?? null,
    createdBy: partial.createdBy ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

/** A promise that is also chainable with `.orderBy()` (a Drizzle select is both awaitable directly and chainable). */
function selectResult(rows: Row[]): Promise<Row[]> & {
  orderBy: (_column: unknown) => Promise<Row[]>;
} {
  const result = Promise.resolve(rows.map((row) => ({ ...row }))) as Promise<
    Row[]
  > & { orderBy: (_column: unknown) => Promise<Row[]> };
  result.orderBy = (_column: unknown) =>
    Promise.resolve(rows.map((row) => ({ ...row })));
  return result;
}

/** A promise that is also chainable with `.returning()`, mirroring the insert/update/delete fakes elsewhere in this repo. */
function writeResult(rows: Row[]): Promise<void> & {
  returning: (_columns?: unknown) => Promise<Row[]>;
} {
  const result = Promise.resolve() as Promise<void> & {
    returning: (_columns?: unknown) => Promise<Row[]>;
  };
  result.returning = (_columns?: unknown) =>
    Promise.resolve(rows.map((row) => ({ ...row })));
  return result;
}

const fakeDb = {
  select: (_columns?: unknown) => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) => selectResult(store.filter(predicate)),
    }),
  }),
  insert: (_table: unknown) => ({
    values: (value: Partial<Row>) => {
      const row = makeRow(value);
      store.push(row);
      return writeResult([row]);
    },
  }),
  update: (_table: unknown) => ({
    set: (patch: Partial<Row>) => ({
      where: (predicate: Predicate) => {
        const updated: Row[] = [];
        for (const row of store) {
          if (predicate(row)) {
            Object.assign(row, patch);
            updated.push(row);
          }
        }
        return writeResult(updated);
      },
    }),
  }),
  delete: (_table: unknown) => ({
    where: (predicate: Predicate) => {
      const removed = store.filter(predicate);
      store = store.filter((row) => !predicate(row));
      return writeResult(removed.map((row) => ({ ...row, id: row.id })));
    },
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleById,
  listSchedules,
  setScheduleEnabled,
  stampScheduleFired,
  updateSchedule,
  validateCron,
} = await import("./schedules");

describe("validateCron", () => {
  test("accepts a standard five-field expression", () => {
    expect(validateCron("0 2 * * *")).toEqual({ ok: true });
  });

  test("accepts a six-field (seconds-first) expression, matching pg-boss's own parser call", () => {
    expect(validateCron("*/30 * * * * *")).toEqual({ ok: true });
  });

  test("rejects garbage with a message", () => {
    const result = validateCron("not a cron expression");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("rejects a field out of range", () => {
    const result = validateCron("60 * * * *");
    expect(result.ok).toBe(false);
  });
});

describe("createSchedule", () => {
  test("rejects an invalid cron before writing a row", async () => {
    store = [];

    const result = await createSchedule({
      organizationId: "org-1",
      sessionId: "session-1",
      name: "Bad schedule",
      cron: "garbage",
      goal: "Do something",
    });

    expect(result.ok).toBe(false);
    expect(store).toHaveLength(0);
  });

  test("creates a row for a valid cron", async () => {
    store = [];

    const result = await createSchedule({
      organizationId: "org-1",
      sessionId: "session-1",
      name: "Nightly suite",
      cron: "0 2 * * *",
      goal: "Run the suite; open a fix PR if it's red.",
    });

    expect(result.ok).toBe(true);
    expect(store).toHaveLength(1);
    if (result.ok) {
      expect(result.schedule.enabled).toBe(true);
      expect(result.schedule.lastFiredAt).toBeNull();
    }
  });
});

describe("updateSchedule", () => {
  test("rejects an invalid cron without mutating the row", async () => {
    store = [makeRow({ id: "sched-1", cron: "0 2 * * *" })];

    const result = await updateSchedule("org-1", "sched-1", {
      name: "Nightly suite",
      sessionId: "session-1",
      cron: "garbage",
      goal: "Run the suite",
    });

    expect(result.ok).toBe(false);
    expect(store[0]?.cron).toBe("0 2 * * *");
  });

  test("updates fields for a valid cron", async () => {
    store = [makeRow({ id: "sched-1", cron: "0 2 * * *" })];

    const result = await updateSchedule("org-1", "sched-1", {
      name: "Renamed",
      sessionId: "session-1",
      cron: "0 3 * * *",
      goal: "Run the suite",
    });

    expect(result.ok).toBe(true);
    expect(store[0]?.name).toBe("Renamed");
    expect(store[0]?.cron).toBe("0 3 * * *");
  });
});

describe("org scoping", () => {
  test("getSchedule does not see another organization's row", async () => {
    store = [makeRow({ id: "sched-1", organizationId: "org-2" })];

    expect(await getSchedule("org-1", "sched-1")).toBeUndefined();
    expect(await getScheduleById("sched-1")).toBeDefined();
  });

  test("listSchedules only returns the caller's organization", async () => {
    store = [
      makeRow({ id: "mine", organizationId: "org-1" }),
      makeRow({ id: "not-mine", organizationId: "org-2" }),
    ];

    const rows = await listSchedules("org-1");
    expect(rows.map((row) => row.id)).toEqual(["mine"]);
  });
});

describe("setScheduleEnabled", () => {
  test("flips enabled without touching other fields", async () => {
    store = [makeRow({ id: "sched-1", enabled: true, name: "Keep me" })];

    const row = await setScheduleEnabled("org-1", "sched-1", false);

    expect(row?.enabled).toBe(false);
    expect(row?.name).toBe("Keep me");
  });
});

describe("stampScheduleFired", () => {
  test("sets lastFiredAt", async () => {
    store = [makeRow({ id: "sched-1", lastFiredAt: null })];
    const firedAt = new Date("2026-08-25T02:00:00Z");

    await stampScheduleFired("org-1", "sched-1", firedAt);

    expect(store[0]?.lastFiredAt).toEqual(firedAt);
  });
});

describe("deleteSchedule", () => {
  test("removes the row and reports success", async () => {
    store = [makeRow({ id: "sched-1" })];

    const deleted = await deleteSchedule("org-1", "sched-1");

    expect(deleted).toBe(true);
    expect(store).toHaveLength(0);
  });

  test("reports failure for a row in another organization", async () => {
    store = [makeRow({ id: "sched-1", organizationId: "org-2" })];

    const deleted = await deleteSchedule("org-1", "sched-1");

    expect(deleted).toBe(false);
    expect(store).toHaveLength(1);
  });
});
