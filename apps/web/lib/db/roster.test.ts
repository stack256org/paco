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

const fakeDb = {
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
      for (const value of rows) {
        store.push(makeRow(value));
      }
      return Promise.resolve();
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
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const {
  DEFAULT_ROSTER,
  deleteRosterAgent,
  getRoster,
  seedDefaultRoster,
  setRosterAgentEnabled,
  upsertRosterAgent,
} = await import("./roster");

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
