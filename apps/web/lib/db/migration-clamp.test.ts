import { describe, expect, test } from "bun:test";
import { computeMigrationClamps } from "./migration-clamp";

const JOURNAL = [
  { hash: "hash-0000", when: 1_000 },
  { hash: "hash-0001", when: 2_000 },
  { hash: "hash-0005", when: 3_000 },
  { hash: "hash-0006", when: 4_000 },
  { hash: "hash-0007", when: 5_000 },
];

describe("computeMigrationClamps", () => {
  test("is a no-op on a healthy ledger", () => {
    const records = JOURNAL.map((entry, index) => ({
      id: index,
      hash: entry.hash,
      createdAt: entry.when,
    }));

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([]);
  });

  test("clamps a record recorded later than every journal entry, back to its own", () => {
    // Mirrors the real bug: 0005 was recorded at a synthetic future
    // timestamp, later than 0006 and 0007's real ones.
    const records = [
      { id: 0, hash: "hash-0000", createdAt: 1_000 },
      { id: 1, hash: "hash-0001", createdAt: 2_000 },
      { id: 2, hash: "hash-0005", createdAt: 9_999_999 },
      { id: 3, hash: "hash-0006", createdAt: 4_000 },
      { id: 4, hash: "hash-0007", createdAt: 5_000 },
    ];

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([
      { id: 2, hash: "hash-0005", from: 9_999_999, to: 3_000 },
    ]);
  });

  test("leaves a record alone whose hash matches no journal entry", () => {
    const records = [
      { id: 0, hash: "hash-deleted-migration", createdAt: 9_999_999 },
    ];

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([]);
  });

  test("leaves a null created_at alone", () => {
    const records = [{ id: 0, hash: "hash-0000", createdAt: null }];

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([]);
  });

  test("is a no-op with an empty journal", () => {
    const records = [{ id: 0, hash: "hash-0000", createdAt: 9_999_999 }];

    expect(computeMigrationClamps(records, [])).toEqual([]);
  });

  test("does not re-clamp a record already at its correct value", () => {
    const records = [{ id: 2, hash: "hash-0005", createdAt: 3_000 }];

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([]);
  });

  test("clamps more than one out-of-order record in the same pass", () => {
    const records = [
      { id: 2, hash: "hash-0005", createdAt: 9_999_999 },
      { id: 5, hash: "hash-0001", createdAt: 8_888_888 },
    ];

    expect(computeMigrationClamps(records, JOURNAL)).toEqual([
      { id: 2, hash: "hash-0005", from: 9_999_999, to: 3_000 },
      { id: 5, hash: "hash-0001", from: 8_888_888, to: 2_000 },
    ]);
  });
});
