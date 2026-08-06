import { describe, expect, mock, test } from "bun:test";
// Used only for table identity (`insert(organizations)` vs
// `insert(organizationMembers)`) and column identity (the `onConflictDoNothing`
// target) — a pure schema definition with no side effects, so importing it
// here does not touch a database.
import { organizationMembers, organizations } from "@/lib/db/schema";

mock.module("server-only", () => ({}));

type Row = Record<string, unknown>;

let orgs: Row[] = [];
let members: Row[] = [];

/**
 * `ensureOrganizationWithOwner`'s whole job is refusing to produce a second
 * organisation when two people sign in at the same moment. That guarantee
 * now lives in a database constraint (`organizations.singleton` is `NOT
 * NULL UNIQUE`, always `true`), not in application-level locking — so the
 * fake has to model the constraint, not just replay whatever the code does.
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

// Given an explicit type rather than left to infer from its own initializer:
// `transaction`'s `typeof fakeDb` reference is circular, which TypeScript
// resolves as an implicit `any` (TS7022) instead of erroring on it directly.
type FakeDb = {
  select: () => {
    from: (table: unknown) => { limit: () => Promise<Row[]> };
  };
  insert: (table: unknown) => {
    values: (values: Row) => {
      onConflictDoNothing: (
        config?: unknown,
      ) => { returning: () => Promise<Row[]> } | Promise<void>;
    };
  };
  transaction: <T>(cb: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

const fakeDb: FakeDb = {
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

    if (table === organizationMembers) {
      return {
        values: (values: Row) => ({
          onConflictDoNothing: async () => {
            const exists = members.some(
              (member) =>
                member.organizationId === values.organizationId &&
                member.userId === values.userId,
            );
            if (!exists) {
              members.push(values);
            }
          },
        }),
      };
    }

    throw new Error("Fake db: unmapped table referenced in insert");
  },
  transaction: async <T>(cb: (tx: FakeDb) => Promise<T>) => cb(fakeDb),
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

/** Narrows a fake membership row's `userId` field for `expect(...)`. */
function userIdOf(row: Row | undefined): string {
  const userId = row?.userId;
  if (typeof userId !== "string") {
    throw new Error("Fake db: membership row has no string userId");
  }
  return userId;
}

describe("ensureOrganizationWithOwner", () => {
  test("creates the organisation and its owner on a fresh install", async () => {
    orgs = [];
    members = [];
    const { ensureOrganizationWithOwner } = await modulePromise;

    const org = await ensureOrganizationWithOwner("user-1", "Acme");

    expect(org.name).toBe("Acme");
    expect(orgs.length).toBe(1);
    expect(members.length).toBe(1);
    expect(members[0]?.role).toBe("owner");
  });

  test("is a no-op when an organisation already exists", async () => {
    orgs = [
      { id: "org-1", name: "Existing", singleton: true, createdAt: new Date() },
    ];
    members = [];
    const { ensureOrganizationWithOwner } = await modulePromise;

    const org = await ensureOrganizationWithOwner("user-2");

    expect(org.name).toBe("Existing");
    expect(orgs.length).toBe(1);
    // The second person must NOT become a second owner.
    expect(members.length).toBe(0);
  });

  test("two people signing in at the same moment produce one organisation and one owner, never two", async () => {
    orgs = [];
    members = [];
    const { ensureOrganizationWithOwner } = await modulePromise;

    // Both callers start before either finishes — this is the race itself,
    // not a simulation described in a comment. `jitter()` inside the fake's
    // insert is what makes that true: without it, the first call would run
    // to completion (including the membership insert) before the second
    // call's `insert` even executes, and the test would pass for reasons
    // that have nothing to do with the constraint being exercised here.
    const [orgFromA, orgFromB] = await Promise.all([
      ensureOrganizationWithOwner("user-a", "Acme"),
      ensureOrganizationWithOwner("user-b", "Acme"),
    ]);

    // Structurally one row: whichever caller's INSERT the fake's
    // check-then-commit section let through.
    expect(orgs.length).toBe(1);

    // Both callers must agree on which organisation exists — the loser
    // re-reads the winner's row rather than fabricating its own.
    expect(orgFromA.id).toBe(orgFromB.id);
    expect(orgFromA.id).toBe(idOf(orgs[0]));

    // Exactly one owner membership — for whichever caller actually created
    // the organisation — never two, and never zero.
    expect(members.length).toBe(1);
    expect(members[0]?.role).toBe("owner");
    expect(["user-a", "user-b"]).toContain(userIdOf(members[0]));
  });
});
