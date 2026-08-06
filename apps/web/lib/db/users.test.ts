import { describe, expect, mock, test } from "bun:test";
import { users } from "@/lib/db/schema";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

let rows: Row[] = [];

/**
 * `userExistsByEmail` used to compare with `ilike(users.email, email)`.
 * `z.email()` rejects `%` but accepts `_` — a single-character LIKE
 * wildcard — so inviting `bob_smith@corp.com` could false-positive against
 * an unrelated `bobXsmith@corp.com`. This fake has to actually model that
 * distinction (exact, case-insensitive match vs. LIKE-with-wildcards) rather
 * than approximate it, or a regression back to `ilike` would pass every test
 * below just the same.
 */
const COLUMN_KEYS = new Map<unknown, string>([
  [users.id, "id"],
  [users.email, "email"],
  [users.isAdmin, "isAdmin"],
]);

function keyFor(column: unknown): string {
  const key = COLUMN_KEYS.get(column);
  if (!key) {
    throw new Error("Fake db: unmapped column referenced in a test");
  }
  return key;
}

type LowerColumn = { __lowerColumn: unknown };

function isLowerColumn(value: unknown): value is LowerColumn {
  return (
    typeof value === "object" && value !== null && "__lowerColumn" in value
  );
}

const actualDrizzle = await import("drizzle-orm");

mock.module("drizzle-orm", () => ({
  ...actualDrizzle,
  eq:
    (column: unknown, value: unknown): Predicate =>
    (row) => {
      if (isLowerColumn(column)) {
        const actual = row[keyFor(column.__lowerColumn)];
        return typeof actual === "string" && actual.toLowerCase() === value;
      }
      return row[keyFor(column)] === value;
    },
  sql: (
    strings: readonly string[],
    ...values: unknown[]
  ): LowerColumn | never => {
    if (strings[0] === "lower(" && strings[1] === ")" && values.length === 1) {
      return { __lowerColumn: values[0] };
    }
    throw new Error("Fake sql: unsupported template in this test");
  },
}));

const fakeDb = {
  select: () => ({
    from: () => ({
      where: (predicate: Predicate) => ({
        limit: async (n: number) => rows.filter(predicate).slice(0, n),
      }),
    }),
  }),
};

mock.module("@/lib/db/client", () => ({ db: fakeDb }));

const modulePromise = import("./users");

describe("userExistsByEmail", () => {
  test("matches an existing address case-insensitively", async () => {
    rows = [{ id: "u1", email: "Alice@example.com", isAdmin: false }];

    const { userExistsByEmail } = await modulePromise;

    expect(await userExistsByEmail("alice@example.com")).toBe(true);
  });

  test("does not treat '_' as a wildcard — an underscore address never matches a similar-looking one", async () => {
    // The failure this reproduces: `ilike` treats `_` as "any one character",
    // so inviting bob_smith@corp.com could match an unrelated
    // bobXsmith@corp.com and get refused as "already has an account".
    rows = [{ id: "u1", email: "bobXsmith@corp.com", isAdmin: false }];

    const { userExistsByEmail } = await modulePromise;

    expect(await userExistsByEmail("bob_smith@corp.com")).toBe(false);
  });

  test("returns false when no account matches at all", async () => {
    rows = [];

    const { userExistsByEmail } = await modulePromise;

    expect(await userExistsByEmail("nobody@example.com")).toBe(false);
  });
});
