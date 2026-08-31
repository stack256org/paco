import { describe, expect, mock, test } from "bun:test";
// Used only for table identity (`insert(organizations)`) and column identity
// (the `onConflictDoNothing` target) — a pure schema definition with no side
// effects, so importing it here does not touch a database.
import { organizations } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

/**
 * `getOrganization` calls `seedDefaultRoster` once it knows it won the
 * creation race. Roster internals (validation, idempotence, the default
 * agents) are `roster.test.ts`'s job — this file only needs to know whether,
 * and for which organisation id, the call happened.
 */
let seedCalls: string[] = [];
mock.module("@/lib/db/roster", () => ({
  seedDefaultRoster: (organizationId: string) => {
    seedCalls.push(organizationId);
    return Promise.resolve();
  },
}));

type Row = Record<string, unknown>;

let orgs: Row[] = [];

/**
 * `getOrganization`'s whole job, once no row exists yet, is refusing to
 * produce a second organisation when two callers reach it at the same
 * moment. That guarantee lives in a database constraint
 * (`organizations.singleton` is `NOT NULL UNIQUE`, always `true`), not in
 * application-level locking — so the fake has to model the constraint, not
 * just replay whatever the code does.
 *
 * The critical section below (`if (orgs.length > 0) { reject } else {
 * commit }`) is the fake's stand-in for that unique index: Postgres
 * guarantees a second conflicting INSERT either waits for the first to
 * commit and then sees the conflict, or is serialised some other way — it
 * can never observe "no row yet" once a winner has committed. The `await`
 * with a random delay *before* that check is what makes two calls issued
 * via `Promise.all` actually interleave their async work first, instead of
 * one silently running start-to-finish before the other begins (which is
 * what plain synchronous JS would otherwise give us for free, and would
 * prove nothing about the race). The check-then-commit step itself stays
 * free of `await`, matching the fact that a real unique constraint check is
 * a single atomic operation in Postgres, not two.
 *
 * This models the failure mode the fix closes — a naive fake would let two
 * concurrent callers both see zero rows and both "win" — without needing a
 * real Postgres instance or true OS-level concurrency, which a bun:test
 * unit test does not have.
 */
function jitter(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
}

const fakeDb = {
  select: () => ({
    from: (_table: unknown) => ({
      limit: async () => orgs.slice(0, 1),
    }),
  }),
  insert: (table: unknown) => {
    if (table === organizations) {
      return {
        values: (values: Row) => ({
          onConflictDoNothing: (_config?: unknown) => ({
            returning: async () => {
              await jitter();
              if (orgs.length > 0) {
                // The constraint rejected this INSERT — exactly what
                // `onConflictDoNothing` turns a real unique-violation into:
                // zero rows, not a thrown error.
                return [];
              }
              orgs.push(values);
              return [values];
            },
          }),
        }),
      };
    }

    throw new Error("Fake db: unmapped table referenced in insert");
  },
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const modulePromise = import("./organization");

/** Narrows a fake row's `id` field for use in `expect(...).toBe(...)`. */
function idOf(row: Row | undefined): string {
  const id = row?.id;
  if (typeof id !== "string") {
    throw new Error("Fake db: row has no string id");
  }
  return id;
}

describe("getOrganization", () => {
  test("creates the organisation on a fresh install", async () => {
    orgs = [];
    seedCalls = [];
    const { getOrganization } = await modulePromise;

    const org = await getOrganization();

    expect(org.name).toBe("Paco");
    expect(orgs.length).toBe(1);
    // The roster is seeded exactly once, for the organisation just created.
    expect(seedCalls).toEqual([org.id]);
  });

  test("is a no-op when an organisation already exists", async () => {
    orgs = [
      { id: "org-1", name: "Existing", singleton: true, createdAt: new Date() },
    ];
    seedCalls = [];
    const { getOrganization } = await modulePromise;

    const org = await getOrganization();

    expect(org.name).toBe("Existing");
    expect(orgs.length).toBe(1);
    // Nor does an already-existing organisation get re-seeded.
    expect(seedCalls).toEqual([]);
  });

  test("two callers arriving at the same moment produce one organisation, never two", async () => {
    orgs = [];
    seedCalls = [];
    const { getOrganization } = await modulePromise;

    // Both callers start before either finishes — this is the race itself,
    // not a simulation described in a comment. `jitter()` inside the fake's
    // insert is what makes that true: without it, the first call would run
    // to completion before the second call's `insert` even executes, and
    // the test would pass for reasons that have nothing to do with the
    // constraint being exercised here.
    const [orgFromA, orgFromB] = await Promise.all([
      getOrganization(),
      getOrganization(),
    ]);

    // Structurally one row: whichever caller's INSERT the fake's
    // check-then-commit section let through.
    expect(orgs.length).toBe(1);

    // Both callers must agree on which organisation exists — the loser
    // re-reads the winner's row rather than fabricating its own.
    expect(orgFromA.id).toBe(orgFromB.id);
    expect(orgFromA.id).toBe(idOf(orgs[0]));

    // Only the winner's call reaches seedDefaultRoster — never the loser's,
    // and never twice.
    expect(seedCalls).toEqual([orgFromA.id]);
  });
});
