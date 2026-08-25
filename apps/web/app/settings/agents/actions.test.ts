import { describe, expect, mock, test } from "bun:test";
import { rosterAgents } from "@/lib/db/schema";

// `roster.ts` (imported for real below, not mocked) is server-only.
mock.module("server-only", () => ({}));

type Row = {
  id: string;
  organizationId: string;
  name: string;
  definition: unknown;
  builtin: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type Predicate = (row: Row) => boolean;

/**
 * Given an explicit type rather than left to infer from its own initializer
 * (same reasoning as `lib/org/organization.test.ts`'s `FakeDb`):
 * `transaction`'s `typeof fakeDb` reference is circular, which TypeScript
 * resolves as an implicit `any` (TS7022) instead of erroring on it directly.
 */
type FakeDb = {
  select: (columns?: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (predicate: Predicate) => Promise<Record<string, unknown>[]>;
    };
  };
  insert: (table: unknown) => {
    values: (values: Partial<Row> | Array<Partial<Row>>) => {
      onConflictDoNothing: (config?: {
        target?: unknown[];
      }) => Promise<void> & {
        returning: (columns?: unknown) => Promise<Row[]>;
      };
      onConflictDoUpdate: (config: {
        target?: unknown[];
        set: Partial<Row>;
      }) => Promise<void>;
    };
  };
  update: (table: unknown) => {
    set: (patch: Partial<Row>) => {
      where: (predicate: Predicate) => Promise<void>;
    };
  };
  delete: (table: unknown) => {
    where: (predicate: Predicate) => Promise<void>;
  };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

/**
 * Same fake-db trick as `lib/db/roster.test.ts`: a tiny in-memory store plus
 * real column objects from the schema, so a mocked `eq`/`and` filters it the
 * way Drizzle would filter real rows. Copied rather than shared because this
 * file exercises both `actions.ts`'s own direct queries (the collision and
 * list-everything reads `roster.ts` has no reason to expose) and the real,
 * unmocked `upsertRosterAgent` / `deleteRosterAgent` / `setRosterAgentEnabled`
 * — so the fake has to satisfy both callers against one shared store.
 */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [rosterAgents.id, "id"],
  [rosterAgents.organizationId, "organizationId"],
  [rosterAgents.name, "name"],
  [rosterAgents.builtin, "builtin"],
  [rosterAgents.enabled, "enabled"],
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
}));

let store: Row[] = [];

function findConflict(
  value: Partial<Row>,
  target: unknown[] | undefined,
): Row | undefined {
  if (!target) {
    return undefined;
  }
  const keys = target.map((column) => keyFor(column));
  return store.find((row) => keys.every((key) => row[key] === value[key]));
}

function makeRow(partial: Partial<Row>): Row {
  const now = new Date();
  return {
    id: partial.id ?? `row-${store.length}`,
    organizationId: partial.organizationId ?? "org-1",
    name: partial.name ?? "agent",
    definition: partial.definition,
    builtin: partial.builtin ?? false,
    enabled: partial.enabled ?? true,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

const fakeDb: FakeDb = {
  select: (columns?: Record<string, unknown>) => ({
    from: (_table: unknown) => ({
      where: (predicate: Predicate) => {
        const matched = store.filter(predicate);
        if (!columns) {
          return Promise.resolve(matched.map((row) => ({ ...row })));
        }
        return Promise.resolve(
          matched.map((row) => {
            const projected: Record<string, unknown> = {};
            for (const [alias, column] of Object.entries(columns)) {
              projected[alias] = row[keyFor(column)];
            }
            return projected;
          }),
        );
      },
    }),
  }),
  insert: (_table: unknown) => ({
    values: (values: Partial<Row> | Array<Partial<Row>>) => {
      const rows = Array.isArray(values) ? values : [values];
      return {
        onConflictDoNothing: (config?: { target?: unknown[] }) => {
          const insertedRows: Row[] = [];
          for (const value of rows) {
            if (findConflict(value, config?.target)) {
              continue;
            }
            const newRow = makeRow(value);
            store.push(newRow);
            insertedRows.push(newRow);
          }
          // Awaitable directly, and chainable with `.returning()` — see
          // `lib/db/roster.test.ts`'s identical fake for why both are needed.
          const result = Promise.resolve() as Promise<void> & {
            returning: (columns?: unknown) => Promise<Row[]>;
          };
          result.returning = (_columns?: unknown) =>
            Promise.resolve(insertedRows.map((row) => ({ ...row })));
          return result;
        },
        onConflictDoUpdate: (config: {
          target?: unknown[];
          set: Partial<Row>;
        }) => {
          for (const value of rows) {
            const existing = findConflict(value, config.target);
            if (existing) {
              Object.assign(existing, config.set);
            } else {
              store.push(makeRow(value));
            }
          }
          return Promise.resolve();
        },
      };
    },
  }),
  update: (_table: unknown) => ({
    set: (patch: Partial<Row>) => ({
      where: (predicate: Predicate) => {
        for (const row of store) {
          if (predicate(row)) {
            Object.assign(row, patch);
          }
        }
        return Promise.resolve();
      },
    }),
  }),
  delete: (_table: unknown) => ({
    where: (predicate: Predicate) => {
      store = store.filter((row) => !predicate(row));
      return Promise.resolve();
    },
  }),
  /**
   * `saveRosterAgent`'s rename path calls the real `renameRosterAgent`,
   * which runs inside `db.transaction` — snapshot/restore on throw, same as
   * `lib/db/roster.test.ts`'s fake.
   */
  transaction: async <T>(fn: (tx: typeof fakeDb) => Promise<T>): Promise<T> => {
    const snapshot = store.map((row) => ({ ...row }));
    try {
      return await fn(fakeDb);
    } catch (error) {
      store = snapshot;
      throw error;
    }
  },
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

let adminOk = true;
mock.module("@/lib/admin/require-admin", () => ({
  requireAdmin: async () => {
    if (!adminOk) {
      throw new Error("Not an administrator");
    }
    return "admin-1";
  },
}));

let organization: { id: string } | null = { id: "org-1" };
mock.module("@/lib/org/organization", () => ({
  getOrganization: async () => organization,
}));

const { deleteRoster, listRosterAgents, saveRosterAgent, setRosterEnabled } =
  await import("./actions");

const VALID_DEFINITION = {
  description: "A test agent.",
  prompt: "You are a test agent.",
};

describe("admin gate", () => {
  test("a non-admin is rejected, not handed a field error", async () => {
    adminOk = false;
    store = [];

    await expect(listRosterAgents()).rejects.toThrow();
    await expect(
      saveRosterAgent({
        originalName: null,
        name: "custom-agent",
        definition: VALID_DEFINITION,
      }),
    ).rejects.toThrow();
    await expect(deleteRoster("custom-agent")).rejects.toThrow();
    await expect(setRosterEnabled("custom-agent", false)).rejects.toThrow();

    adminOk = true;
  });
});

describe("saveRosterAgent", () => {
  test("an invalid name comes back as a field error, not a throw", async () => {
    store = [];

    const result = await saveRosterAgent({
      originalName: null,
      name: "Not Valid!",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(false);
    expect(store).toHaveLength(0);
    if (!result.success) {
      expect(result.fieldErrors?.name).toBeDefined();
    }
  });

  test("an invalid definition comes back as inline field errors, not a throw", async () => {
    store = [];

    const result = await saveRosterAgent({
      originalName: null,
      name: "custom-agent",
      definition: { prompt: "missing a description" },
    });

    expect(result.success).toBe(false);
    expect(store).toHaveLength(0);
    if (!result.success) {
      expect(result.fieldErrors?.description).toBeDefined();
    }
  });

  test("creates a new, non-builtin row for a valid submission", async () => {
    store = [];

    const result = await saveRosterAgent({
      originalName: null,
      name: "custom-agent",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0]?.name).toBe("custom-agent");
    expect(store[0]?.builtin).toBe(false);
  });

  test("refuses to create a new agent under a name already in use", async () => {
    store = [
      makeRow({
        name: "explorer",
        builtin: true,
        definition: VALID_DEFINITION,
      }),
    ];

    const result = await saveRosterAgent({
      originalName: null,
      name: "explorer",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(false);
    // The pre-existing builtin row must be untouched by the refused write.
    expect(store).toHaveLength(1);
    expect(store[0]?.builtin).toBe(true);
  });

  test("edits an existing row in place when the name is unchanged", async () => {
    store = [
      makeRow({
        name: "custom-agent",
        definition: { ...VALID_DEFINITION, description: "v1" },
      }),
    ];

    const result = await saveRosterAgent({
      originalName: "custom-agent",
      name: "custom-agent",
      definition: { ...VALID_DEFINITION, description: "v2" },
    });

    expect(result.success).toBe(true);
    expect(store).toHaveLength(1);
    expect(
      (store[0]?.definition as { description?: string } | undefined)
        ?.description,
    ).toBe("v2");
  });

  test("renames a non-builtin agent: the old name disappears, the new one appears", async () => {
    store = [makeRow({ name: "old-name", definition: VALID_DEFINITION })];

    const result = await saveRosterAgent({
      originalName: "old-name",
      name: "new-name",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(true);
    expect(store.map((row) => row.name)).toEqual(["new-name"]);
  });

  test("refuses to rename a builtin agent", async () => {
    store = [
      makeRow({
        name: "explorer",
        builtin: true,
        definition: VALID_DEFINITION,
      }),
    ];

    const result = await saveRosterAgent({
      originalName: "explorer",
      name: "explorer-renamed",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(false);
    expect(store.map((row) => row.name)).toEqual(["explorer"]);
  });

  test("refuses a rename that collides with another existing agent", async () => {
    store = [
      makeRow({ name: "agent-a", definition: VALID_DEFINITION }),
      makeRow({ name: "agent-b", definition: VALID_DEFINITION }),
    ];

    const result = await saveRosterAgent({
      originalName: "agent-a",
      name: "agent-b",
      definition: VALID_DEFINITION,
    });

    expect(result.success).toBe(false);
    expect(store.map((row) => row.name).sort()).toEqual(["agent-a", "agent-b"]);
  });
});

describe("deleteRoster", () => {
  test("a builtin agent's delete is refused and surfaces an error", async () => {
    store = [
      makeRow({
        name: "explorer",
        builtin: true,
        definition: VALID_DEFINITION,
      }),
    ];

    const result = await deleteRoster("explorer");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(store.some((row) => row.name === "explorer")).toBe(true);
  });

  test("a non-builtin agent is deleted", async () => {
    store = [makeRow({ name: "custom-agent", definition: VALID_DEFINITION })];

    const result = await deleteRoster("custom-agent");

    expect(result.success).toBe(true);
    expect(store).toHaveLength(0);
  });
});

describe("setRosterEnabled", () => {
  test("flips the enabled flag, reflected in the next list read", async () => {
    store = [
      makeRow({
        name: "custom-agent",
        enabled: true,
        definition: VALID_DEFINITION,
      }),
    ];

    await setRosterEnabled("custom-agent", false);
    let rows = await listRosterAgents();
    expect(rows.find((row) => row.name === "custom-agent")?.enabled).toBe(
      false,
    );

    await setRosterEnabled("custom-agent", true);
    rows = await listRosterAgents();
    expect(rows.find((row) => row.name === "custom-agent")?.enabled).toBe(true);
  });
});

describe("listRosterAgents", () => {
  test("includes disabled rows, unlike the runtime roster read", async () => {
    store = [
      makeRow({
        name: "custom-agent",
        enabled: false,
        definition: VALID_DEFINITION,
      }),
    ];

    const rows = await listRosterAgents();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
  });

  test("flags a row whose stored definition no longer validates", async () => {
    store = [
      makeRow({
        name: "broken",
        definition: { prompt: "missing description" },
      }),
    ];

    const rows = await listRosterAgents();

    expect(rows[0]?.valid).toBe(false);
  });

  test("scopes to the current organisation only", async () => {
    store = [
      makeRow({
        organizationId: "org-1",
        name: "mine",
        definition: VALID_DEFINITION,
      }),
      makeRow({
        organizationId: "org-2",
        name: "not-mine",
        definition: VALID_DEFINITION,
      }),
    ];

    const rows = await listRosterAgents();

    expect(rows.map((row) => row.name)).toEqual(["mine"]);
  });
});
