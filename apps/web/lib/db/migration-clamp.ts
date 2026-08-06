/**
 * The pure computation behind clamping a future-dated migration record.
 *
 * `7bd724c` fixed a hand-written migration (`0005_backfill_organization_owner`)
 * that drizzle-kit had stamped with a synthetic `when` two days in the
 * future — later than every migration that followed it in the journal. That
 * fix only rewrote `meta/_journal.json`, which is enough for a fresh
 * install: the journal is the source of truth for where a migration sits in
 * the applied order.
 *
 * It does nothing for an install that had already recorded 0005's *old*
 * timestamp in `drizzle.__drizzle_migrations`. Drizzle's migrator decides
 * what still needs applying by comparing each journal entry's `when`
 * against `SELECT created_at ... ORDER BY created_at DESC LIMIT 1` — the
 * newest timestamp it has already applied. With 0005's row still recording
 * the old, future-dated value, migrations 0006 and 0007 (genuinely later
 * work, stamped with real times that are now *older* than that recorded
 * value) read as already applied and are skipped — silently: the build
 * reports success, and the app then throws on nearly every chat read, since
 * `getChatSummariesBySessionId` selects a column that migration never added.
 *
 * The fix is to correct the *recorded* row, not just the journal: any
 * migration whose recorded `created_at` sits later than every entry in the
 * current journal is, by definition, out of order relative to the ledger
 * `7bd724c` already fixed — and its own journal entry (matched by hash, the
 * same identity Drizzle itself keys migrations by) says what the correct
 * value should have been all along.
 */

export type JournalEntry = {
  /** Identifies a migration file; matches the `hash` column in
   * `__drizzle_migrations`. */
  hash: string;
  /** The journal's own timestamp for this migration, after `7bd724c`. */
  when: number;
};

export type MigrationRecord = {
  /** Primary key of the row in `__drizzle_migrations`, for the `UPDATE`. */
  id: number;
  hash: string;
  /** `null` is a row with no timestamp at all — nothing to clamp. */
  createdAt: number | null;
};

export type MigrationClamp = {
  id: number;
  hash: string;
  from: number;
  to: number;
};

/**
 * Which recorded migrations need their `created_at` corrected, and to what.
 *
 * A no-op on a healthy ledger: every recorded timestamp that is already no
 * later than the newest journal entry is left untouched, since it cannot be
 * causing later migrations to be skipped. A record whose hash matches no
 * journal entry (a migration file that no longer exists) is also left
 * alone — there is nothing to correct it *to*.
 */
export function computeMigrationClamps(
  records: MigrationRecord[],
  journal: JournalEntry[],
): MigrationClamp[] {
  if (journal.length === 0) {
    return [];
  }

  const newestWhen = Math.max(...journal.map((entry) => entry.when));
  const whenByHash = new Map(journal.map((entry) => [entry.hash, entry.when]));

  const clamps: MigrationClamp[] = [];
  for (const record of records) {
    if (record.createdAt === null || !Number.isFinite(record.createdAt)) {
      continue;
    }
    if (record.createdAt <= newestWhen) {
      continue;
    }

    const correctWhen = whenByHash.get(record.hash);
    if (correctWhen === undefined || correctWhen === record.createdAt) {
      continue;
    }

    clamps.push({
      id: record.id,
      hash: record.hash,
      from: record.createdAt,
      to: correctWhen,
    });
  }

  return clamps;
}
