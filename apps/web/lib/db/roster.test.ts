import { describe, expect, mock, spyOn, test } from "bun:test";
import { rosterAgents } from "@/lib/db/schema";

// The module under test is server-only; the marker package throws outside a
// server component and has nothing to do with what is being tested.
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
 * Same trick as `session-events.test.ts` and `organization.test.ts`: a tiny
 * in-memory store plus real column objects from the schema, so a mocked
 * `eq`/`and` can filter it the way Drizzle would filter real rows, without
 * standing up a real Postgres.
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

/** Narrows a stored row's `definition.description` for use in `expect(...)`. */
function descriptionOf(row: Row | undefined): string | undefined {
  const definition = row?.definition as { description?: string } | undefined;
  return definition?.description;
}

/**
 * Resolves a real Postgres `ON CONFLICT (target...)` clause against the
 * fake store: finds the row (if any) whose columns named by `target` all
 * match `value`'s. Mirrors `roster_agents_org_name_idx`, the only unique
 * index `roster.ts` ever conflicts against.
 */
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
    id: partial.id ?? "row-id",
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
        /**
         * Models `roster_agents_org_name_idx`: a plain insert would throw in
         * real Postgres on a duplicate (organizationId, name), but nothing
         * in `roster.ts` inserts without an `onConflict*` clause any more,
         * so only those two conflict-aware paths need modelling here.
         */
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
          // Awaitable directly (`await ...onConflictDoNothing(cfg)`, as
          // `seedDefaultRoster` does) *and* chainable with `.returning()`
          // (as `renameRosterAgent` does) — a real `Promise` with a
          // `returning` method hung off it satisfies both call shapes.
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
   * A minimal stand-in for a real transaction: runs `fn` against the same
   * fake db (all of its methods close over the shared `store` variable, so
   * `tx` and `fakeDb` are interchangeable), snapshotting `store` first and
   * restoring it if `fn` throws — the property this file's `renameRosterAgent`
   * tests actually rely on: a failure partway through leaves nothing behind.
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

// Captured before any test can reassign `fakeDb.delete` to force a mid-
// transaction failure — restored afterwards so later tests see the real one.
const originalDelete = fakeDb.delete;

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  DEFAULT_ROSTER,
  deleteRosterAgent,
  getRoster,
  renameRosterAgent,
  seedDefaultRoster,
  setRosterAgentEnabled,
  upsertRosterAgent,
} = await import("./roster");

const VALID_DEFINITION = { description: "d", prompt: "p" };

describe("DEFAULT_ROSTER", () => {
  test("has the four seeded roles", () => {
    expect(Object.keys(DEFAULT_ROSTER).sort()).toEqual([
      "designer",
      "executor",
      "explorer",
      "reviewer",
    ]);
  });
});

describe("seedDefaultRoster", () => {
  test("inserts every default agent for a fresh org", async () => {
    store = [];
    await seedDefaultRoster("org-1");

    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
    expect(store.every((row) => row.organizationId === "org-1")).toBe(true);
    expect(store.every((row) => row.builtin)).toBe(true);
    expect(new Set(store.map((row) => row.name))).toEqual(
      new Set(Object.keys(DEFAULT_ROSTER)),
    );
  });

  test("is idempotent: running it twice does not duplicate rows", async () => {
    store = [];
    await seedDefaultRoster("org-1");
    await seedDefaultRoster("org-1");

    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
  });

  test("only fills in what is missing, never overwrites an edited row", async () => {
    store = [];
    await seedDefaultRoster("org-1");
    const explorerRow = store.find((row) => row.name === "explorer");
    if (!explorerRow) {
      throw new Error("expected an explorer row to have been seeded");
    }
    // Simulate a user edit.
    explorerRow.definition = { ...DEFAULT_ROSTER.explorer, model: "opus" };

    await seedDefaultRoster("org-1");

    const stillEdited = store.find((row) => row.name === "explorer");
    const editedDefinition = stillEdited?.definition as
      | { model?: string }
      | undefined;
    expect(editedDefinition?.model).toBe("opus");
    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
  });

  test("does not affect a different organisation", async () => {
    store = [];
    await seedDefaultRoster("org-1");
    await seedDefaultRoster("org-2");

    expect(store.filter((row) => row.organizationId === "org-1")).toHaveLength(
      Object.keys(DEFAULT_ROSTER).length,
    );
    expect(store.filter((row) => row.organizationId === "org-2")).toHaveLength(
      Object.keys(DEFAULT_ROSTER).length,
    );
  });

  test("two concurrent calls on a fresh org insert exactly four rows, never throwing", async () => {
    store = [];

    // Both calls start before either finishes seeding — the race this
    // guards against: two `getRoster` calls (or an org-creation call racing
    // a lazy-seed call) hitting an org with zero rows at the same moment.
    // Before this used `onConflictDoNothing`, a select-then-insert version
    // let both calls compute the same "four missing" list from a
    // pre-insert snapshot and both insert it, doubling the rows in this
    // fake and throwing a unique-violation against real Postgres.
    await Promise.all([seedDefaultRoster("org-1"), seedDefaultRoster("org-1")]);

    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
    expect(new Set(store.map((row) => row.name))).toEqual(
      new Set(Object.keys(DEFAULT_ROSTER)),
    );
  });
});

describe("getRoster", () => {
  test("seeds lazily when the org has zero rows", async () => {
    store = [];
    const roster = await getRoster("org-1");

    expect(Object.keys(roster).sort()).toEqual([
      "designer",
      "executor",
      "explorer",
      "reviewer",
    ]);
    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
  });

  test("excludes disabled rows", async () => {
    store = [];
    await seedDefaultRoster("org-1");
    await setRosterAgentEnabled("org-1", "designer", false);

    const roster = await getRoster("org-1");

    expect(Object.keys(roster)).not.toContain("designer");
    expect(Object.keys(roster)).toContain("explorer");
  });

  test("skips an invalid jsonb row and logs it, without throwing", async () => {
    store = [
      makeRow({
        id: "bad-1",
        organizationId: "org-1",
        name: "broken",
        definition: { prompt: "missing description" },
      }),
      makeRow({
        id: "good-1",
        organizationId: "org-1",
        name: "explorer",
        definition: DEFAULT_ROSTER.explorer,
      }),
    ];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      // silence expected log during the test
    });

    const roster = await getRoster("org-1");

    expect(Object.keys(roster)).toEqual(["explorer"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("only returns rows for the requested organisation", async () => {
    store = [];
    await seedDefaultRoster("org-1");
    await seedDefaultRoster("org-2");
    await upsertRosterAgent("org-2", "custom-agent", {
      description: "org-2 only",
      prompt: "You are custom.",
    });

    const rosterOne = await getRoster("org-1");
    const rosterTwo = await getRoster("org-2");

    expect(Object.keys(rosterOne)).not.toContain("custom-agent");
    expect(Object.keys(rosterTwo)).toContain("custom-agent");
  });

  test("two concurrent calls on an empty org both resolve to the four defaults", async () => {
    store = [];

    const [rosterA, rosterB] = await Promise.all([
      getRoster("org-1"),
      getRoster("org-1"),
    ]);

    const expectedNames = new Set(Object.keys(DEFAULT_ROSTER));
    expect(new Set(Object.keys(rosterA))).toEqual(expectedNames);
    expect(new Set(Object.keys(rosterB))).toEqual(expectedNames);
    // No duplicate rows landed in the store either.
    expect(store).toHaveLength(Object.keys(DEFAULT_ROSTER).length);
  });
});

describe("upsertRosterAgent", () => {
  test("rejects an invalid name without writing anything", async () => {
    store = [];
    const result = await upsertRosterAgent("org-1", "Not Valid!", {
      description: "d",
      prompt: "p",
    });

    expect(result.ok).toBe(false);
    expect(store).toHaveLength(0);
  });

  test("rejects an invalid definition without writing anything", async () => {
    store = [];
    const result = await upsertRosterAgent("org-1", "custom-agent", {
      prompt: "missing description",
    });

    expect(result.ok).toBe(false);
    expect(store).toHaveLength(0);
  });

  test("creates a new non-builtin row for a valid definition", async () => {
    store = [];
    const result = await upsertRosterAgent("org-1", "custom-agent", {
      description: "d",
      prompt: "p",
    });

    expect(result.ok).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0]?.builtin).toBe(false);
    expect(store[0]?.name).toBe("custom-agent");
  });

  test("updates an existing row in place rather than duplicating it", async () => {
    store = [];
    await upsertRosterAgent("org-1", "custom-agent", {
      description: "v1",
      prompt: "p",
    });
    await upsertRosterAgent("org-1", "custom-agent", {
      description: "v2",
      prompt: "p",
    });

    expect(store).toHaveLength(1);
    expect(descriptionOf(store[0])).toBe("v2");
  });

  test("updating an existing builtin agent keeps it builtin", async () => {
    store = [];
    await seedDefaultRoster("org-1");

    const result = await upsertRosterAgent("org-1", "explorer", {
      description: "customised explorer",
      prompt: "You are a customised explorer.",
      model: "opus",
    });

    expect(result.ok).toBe(true);
    const explorerRow = store.find(
      (row) => row.organizationId === "org-1" && row.name === "explorer",
    );
    expect(explorerRow?.builtin).toBe(true);
    expect(descriptionOf(explorerRow)).toBe("customised explorer");
    // No duplicate row was created for the same (org, name).
    expect(
      store.filter(
        (row) => row.name === "explorer" && row.organizationId === "org-1",
      ),
    ).toHaveLength(1);
  });
});

describe("deleteRosterAgent", () => {
  test("refuses to delete a builtin agent", async () => {
    store = [];
    await seedDefaultRoster("org-1");

    const result = await deleteRosterAgent("org-1", "explorer");

    expect(result.ok).toBe(false);
    expect(store.some((row) => row.name === "explorer")).toBe(true);
  });

  test("deletes a non-builtin agent", async () => {
    store = [];
    await upsertRosterAgent("org-1", "custom-agent", {
      description: "d",
      prompt: "p",
    });

    const result = await deleteRosterAgent("org-1", "custom-agent");

    expect(result.ok).toBe(true);
    expect(store.some((row) => row.name === "custom-agent")).toBe(false);
  });

  test("reports an error for a name that does not exist", async () => {
    store = [];
    const result = await deleteRosterAgent("org-1", "nope");

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("setRosterAgentEnabled", () => {
  test("flips the enabled flag without touching the definition", async () => {
    store = [];
    await upsertRosterAgent("org-1", "custom-agent", {
      description: "d",
      prompt: "p",
    });

    await setRosterAgentEnabled("org-1", "custom-agent", false);

    expect(store[0]?.enabled).toBe(false);
    expect(descriptionOf(store[0])).toBe("d");
  });
});

describe("renameRosterAgent", () => {
  test("moves a non-builtin agent to its new name, applying the new definition", async () => {
    store = [
      makeRow({
        name: "old-name",
        definition: { description: "v1", prompt: "p" },
      }),
    ];

    const result = await renameRosterAgent("org-1", "old-name", "new-name", {
      description: "v2",
      prompt: "p",
    });

    expect(result.ok).toBe(true);
    expect(store.map((row) => row.name)).toEqual(["new-name"]);
    expect(descriptionOf(store[0])).toBe("v2");
  });

  test("refuses to rename a builtin agent, leaving it untouched", async () => {
    store = [
      makeRow({
        name: "explorer",
        builtin: true,
        definition: VALID_DEFINITION,
      }),
    ];

    const result = await renameRosterAgent(
      "org-1",
      "explorer",
      "explorer-2",
      VALID_DEFINITION,
    );

    expect(result.ok).toBe(false);
    expect(store.map((row) => row.name)).toEqual(["explorer"]);
  });

  test("refuses when the target name is already taken, leaving both rows as they were", async () => {
    store = [
      makeRow({ name: "agent-a", definition: VALID_DEFINITION }),
      makeRow({ name: "agent-b", definition: VALID_DEFINITION }),
    ];

    const result = await renameRosterAgent(
      "org-1",
      "agent-a",
      "agent-b",
      VALID_DEFINITION,
    );

    expect(result.ok).toBe(false);
    expect(store.map((row) => row.name).sort()).toEqual(["agent-a", "agent-b"]);
  });

  test("reports an error when the source name does not exist", async () => {
    store = [];

    const result = await renameRosterAgent(
      "org-1",
      "nope",
      "new-name",
      VALID_DEFINITION,
    );

    expect(result.ok).toBe(false);
    expect(store).toHaveLength(0);
  });

  test("rejects an invalid new name without writing anything", async () => {
    store = [makeRow({ name: "old-name", definition: VALID_DEFINITION })];

    const result = await renameRosterAgent(
      "org-1",
      "old-name",
      "Not Valid!",
      VALID_DEFINITION,
    );

    expect(result.ok).toBe(false);
    expect(store.map((row) => row.name)).toEqual(["old-name"]);
  });

  test("rejects an invalid definition without writing anything", async () => {
    store = [makeRow({ name: "old-name", definition: VALID_DEFINITION })];

    const result = await renameRosterAgent("org-1", "old-name", "new-name", {
      prompt: "missing description",
    });

    expect(result.ok).toBe(false);
    expect(store.map((row) => row.name)).toEqual(["old-name"]);
  });

  test("is atomic: a failure deleting the old row rolls back the insert of the new one", async () => {
    store = [makeRow({ name: "old-name", definition: VALID_DEFINITION })];

    // Forces the transaction to fail after the insert has already happened,
    // so a real (non-atomic) implementation would leave both rows behind.
    fakeDb.delete = () => {
      throw new Error("simulated failure deleting the old row");
    };

    await expect(
      renameRosterAgent("org-1", "old-name", "new-name", VALID_DEFINITION),
    ).rejects.toThrow();

    fakeDb.delete = originalDelete;

    // The snapshot taken before the transaction is restored: the insert
    // that already ran is undone along with everything else.
    expect(store.map((row) => row.name)).toEqual(["old-name"]);
  });
});
