import { describe, expect, mock, test } from "bun:test";
import { compareMigrations } from "./migration-health";

const journal = [
  { tag: "0000_a", when: 100 },
  { tag: "0001_b", when: 200 },
  { tag: "0002_c", when: 300 },
];

describe("compareMigrations", () => {
  test("everything applied is in sync", () => {
    const result = compareMigrations(journal, [100, 200, 300]);
    expect(result.state).toBe("in-sync");
    expect(result.pendingTags).toEqual([]);
  });

  test("a missing tail is pending", () => {
    const result = compareMigrations(journal, [100, 200]);
    expect(result.state).toBe("pending");
    expect(result.pendingTags).toEqual(["0002_c"]);
  });

  test("an applied timestamp beyond the journal is out of order", () => {
    // This is the shape that silently skipped migrations: something recorded
    // as applied is newer than anything the journal knows about, so the
    // migrator will never consider the entries in between.
    const result = compareMigrations(journal, [100, 200, 999]);
    expect(result.state).toBe("out-of-order");
  });

  test("an empty database is pending, not in sync", () => {
    expect(compareMigrations(journal, []).state).toBe("pending");
  });

  // MINOR: the exact Phase 4 shape. A hand-written entry sits in the middle
  // of the journal with a future timestamp larger than every entry after
  // it. Once that inflated value has itself been recorded as applied,
  // `max(journal)` and the recorded value agree — no applied timestamp
  // reads as newer than "every entry" — so the comparison above alone
  // reports "pending" and advises `db:migrate:apply`, which in that exact
  // state reports success and applies nothing. The journal's own
  // monotonicity has to be checked directly to catch this.
  test("a future-dated middle journal entry is out of order, not pending", () => {
    const journalWithFutureDatedMiddleEntry = [
      { tag: "0000_a", when: 100 },
      { tag: "0001_b", when: 200 },
      { tag: "0005_backfill", when: 9_999_999 },
      { tag: "0006_c", when: 400 },
      { tag: "0007_d", when: 500 },
    ];
    // 0005 has already been applied at its own (inflated) timestamp; 0006
    // and 0007 have real, later timestamps that were never applied.
    const result = compareMigrations(
      journalWithFutureDatedMiddleEntry,
      [100, 200, 9_999_999],
    );

    expect(result.state).toBe("out-of-order");
  });

  test("a monotonic journal with nothing applied is still just pending", () => {
    expect(compareMigrations(journal, []).state).toBe("pending");
  });
});

// CRITICAL: verified against the live database — a real `DrizzleQueryError`
// reports `error.code === undefined` at the top level and the SQLSTATE on
// `error.cause.code`. `readMigrationHealth`'s missing-table guard used to
// test `error.code` directly and never fire against that shape, so a fresh
// database's 42P01 propagated instead of reading as "pending".
let executeImpl: () => Promise<unknown> = () => Promise.resolve([]);

mock.module("@/lib/db/client", () => ({
  db: { execute: () => executeImpl() },
}));

const migrationHealthModule = import("./migration-health");

describe("readMigrationHealth", () => {
  test("a DrizzleQueryError-shaped missing-table error reads as pending, not unavailable", async () => {
    executeImpl = () => {
      const drizzleQueryError = new Error("Failed query", {
        cause: Object.assign(
          new Error('relation "drizzle.__drizzle_migrations" does not exist'),
          { code: "42P01" },
        ),
      });
      drizzleQueryError.name = "DrizzleQueryError";
      return Promise.reject(drizzleQueryError);
    };
    const { readMigrationHealth } = await migrationHealthModule;

    // Resolving at all (rather than rejecting) is the point: the guard
    // caught the missing table and treated it as "nothing applied yet."
    const health = await readMigrationHealth();

    expect(health.state).toBe("pending");
    expect(health.applied).toBe(0);
  });

  test("any other database error still propagates", async () => {
    executeImpl = () => Promise.reject(new Error("connection refused"));
    const { readMigrationHealth } = await migrationHealthModule;

    await expect(readMigrationHealth()).rejects.toThrow("connection refused");
  });
});
